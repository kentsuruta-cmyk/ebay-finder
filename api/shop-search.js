// ウェブ店舗の発掘。
// 旧実装は Google のスニペット3行だけを Claude に渡し、そこから
// email / Instagram / WhatsApp / 価格帯 を「抽出」させていた。スニペットに
// 書かれていない情報が出るはずはなく、空欄か推測が混ざるだけだった。
//
// 新実装は3段構え:
//   1. Serper で候補を集める（ドメイン単位で重複排除）
//   2. Claude で「本当に取引先になり得る店か」を選別（安い判定パス）
//   3. 上位候補だけ実際にページを取得 → 連絡先は HTML から実測
//
// 分析（業態の説明・評価）は /api/shop-analyze に分離してある。
// 1リクエストに全部入れると Vercel の60秒上限を超えて 504 になるため。
const { z } = require('zod');
const { parseJson } = require('../lib/claude');
const { scrapeMany } = require('../lib/scrape');

const MAX_COMBOS = 12;
const RESULTS_PER_COMBO = 10;   // 旧: 5
const SCRAPE_TOP_N = 25;        // 実際に本文を取りに行く件数

// 店舗ではないドメイン（マーケットプレイス・辞典・掲示板・動画）
const BLOCKED_HOSTS = [
  'ebay.', 'amazon.', 'aliexpress.', 'etsy.com', 'walmart.com', 'mercari.',
  'reddit.com', 'youtube.com', 'facebook.com', 'pinterest.', 'quora.com',
  'wikipedia.org', 'fandom.com', 'yelp.com', 'tripadvisor.', 'linkedin.com',
  'x.com', 'twitter.com', 'tiktok.com', 'craigslist.org', 'gumtree.com',
];

const SEARCH_EXCLUSIONS = BLOCKED_HOSTS
  .map(h => `-site:${h.replace(/\.$/, '.com')}`)
  .filter((v, i, a) => a.indexOf(v) === i)
  .slice(0, 8)
  .join(' ');

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isBlocked(url) {
  const h = hostOf(url);
  return !h || BLOCKED_HOSTS.some(b => h.includes(b.replace(/\.$/, '.')));
}

const TriageSchema = z.object({
  candidates: z.array(z.object({
    index: z.number().int(),
    shop_likelihood: z.number().int(),   // 1-5: 実在する小売/卸の自社サイトらしさ
    why: z.string(),
  })),
});


const BUSINESS_CONTEXT = `Kenja Games は日本の中古・ジャンク携帯ゲーム機（Game Boy / GBC / GBA / GBA SP / DS / 3DS / PSP など）の卸売業者です。
海外の「まとまった数を仕入れてくれる」小売店・リペア店・卸業者を探しています。
情報サイト、ブログ、まとめ記事、マーケットプレイスの出品ページは対象外です。`;

async function serperSearch(angle, country, key) {
  const q = `${angle.query} ${SEARCH_EXCLUSIONS}`;
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, gl: country.gl, hl: 'en', num: RESULTS_PER_COMBO }),
  });
  if (!r.ok) throw new Error(`Serper HTTP ${r.status}`);
  const data = await r.json();
  return (data.organic || []).map(item => ({
    region: country.region,
    country: country.label,
    angle: angle.label,
    title: item.title,
    url: item.link,
    snippet: item.snippet || '',
  }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { angles, countries } = req.body || {};
  if (!angles?.length || !countries?.length) {
    return res.status(400).json({ error: 'angles と countries は必須です' });
  }

  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return res.status(500).json({ error: 'SERPER_API_KEY が未設定です' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY が未設定です' });

  const combos = [];
  outer: for (const angle of angles) {
    for (const country of countries) {
      combos.push({ angle, country });
      if (combos.length >= MAX_COMBOS) break outer;
    }
  }

  // ── Step 1: 検索（旧実装は逐次だった。並列にして時間を本文取得に回す）──
  const batches = await Promise.all(
    combos.map(({ angle, country }) => serperSearch(angle, country, serperKey).catch(() => []))
  );
  const rawResults = batches.flat();

  // ドメイン単位で重複排除。旧実装はURL単位だったので同じ店の別ページが並んでいた
  const byHost = new Map();
  for (const r of rawResults) {
    if (isBlocked(r.url)) continue;
    const h = hostOf(r.url);
    if (!byHost.has(h)) byHost.set(h, r);
  }
  const deduped = [...byHost.values()];

  if (deduped.length === 0) {
    return res.status(200).json({ results: [], summary: '', combos: combos.length, total: 0 });
  }

  // ── Step 2: 選別（本文を取りに行く価値がある候補を絞る）──
  let ranked = deduped.map((_, i) => ({ index: i, shop_likelihood: 3, why: '' }));
  try {
    const triage = await parseJson({
      schemaName: 'triage',
      schema: TriageSchema,
      effort: 'low',
      maxTokens: 8000,
      system: BUSINESS_CONTEXT,
      prompt: `以下はGoogle検索の結果です。それぞれについて「実在する小売店・リペア店・卸業者の自社サイト」である可能性を1〜5で評価してください。
情報サイト・ブログ・まとめ記事・マーケットプレイスの出品ページは1にしてください。
全件を漏れなく返してください。

${deduped.map((r, i) => `[${i}] ${r.country} / ${r.angle}\nTitle: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n')}`,
    });
    if (triage.candidates?.length) ranked = triage.candidates;
  } catch (e) {
    console.error('triage failed, falling back to search order:', e.message);
  }

  ranked = ranked
    .filter(c => deduped[c.index])
    .sort((a, b) => b.shop_likelihood - a.shop_likelihood);

  const toScrape = ranked.slice(0, SCRAPE_TOP_N);

  // ── Step 3: 本文を実際に取得。連絡先はここで確定する（AIには作らせない）──
  const scraped = await scrapeMany(toScrape.map(c => deduped[c.index].url), { concurrency: 8 });
  const scrapeByIndex = new Map(toScrape.map((c, i) => [c.index, scraped[i]]));

  // ページ本文と実測した連絡先を返す。分析は /api/shop-analyze が担当する。
  const candidates = toScrape.map(c => {
    const r = deduped[c.index];
    const s = scrapeByIndex.get(c.index) || {};
    return {
      index: c.index,
      company_name: s.title || r.title,
      country: r.country,
      angle: r.angle,
      source_url: r.url,
      website: hostOf(r.url) ? `https://${hostOf(r.url)}` : '',
      title: r.title,
      snippet: r.snippet,
      page_title: s.title || '',
      excerpt: s.fetched ? (s.excerpt || '').slice(0, 1500) : '',
      // ↓ ここから下はすべてページHTMLからの実測値。AIは関与しない
      verified: !!s.fetched,
      email: s.email || '',
      emails: s.emails || [],
      instagram: s.instagram || '',
      facebook: s.facebook || '',
      twitter: s.twitter || '',
      whatsapp: s.whatsapp || '',
    };
  });

  return res.status(200).json({
    candidates,
    combos: combos.length,
    total: candidates.length,
    stats: {
      rawResults: rawResults.length,
      uniqueDomains: deduped.length,
      scraped: candidates.filter(c => c.verified).length,
      withContact: candidates.filter(c => c.email || c.instagram || c.whatsapp).length,
    },
  });
};
