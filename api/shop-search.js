// ウェブ店舗の発掘。
// 旧実装は Google のスニペット3行だけを Claude に渡し、そこから
// email / Instagram / WhatsApp / 価格帯 を「抽出」させていた。スニペットに
// 書かれていない情報が出るはずはなく、空欄か推測が混ざるだけだった。
//
// 新実装は3段構え:
//   1. Serper で候補を集める（ドメイン単位で重複排除）
//   2. Claude で「本当に取引先になり得る店か」を選別（安い判定パス）
//   3. 上位候補だけ実際にページを取得 → 連絡先は HTML から実測、
//      Claude は業態の説明と評価だけを担当（連絡先は生成させない）
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

const DetailSchema = z.object({
  summary: z.string(),
  shops: z.array(z.object({
    index: z.number().int(),
    company_name: z.string(),
    country: z.string(),
    category: z.string(),
    products: z.string(),
    is_real_shop: z.boolean(),
    buys_used_stock: z.enum(['yes', 'likely', 'unknown', 'no']),
    direct_score: z.enum(['A', 'B', 'C']),
    relevance_score: z.number().int(),
    reason: z.string(),
    evidence: z.string(),
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

  // ── Step 4: 業態の説明と評価だけをClaudeに担当させる ──
  const detailInput = toScrape.map(c => {
    const r = deduped[c.index];
    const s = scrapeByIndex.get(c.index) || {};
    return `[${c.index}] ${r.country} / ${r.angle}
URL: ${r.url}
検索タイトル: ${r.title}
検索スニペット: ${r.snippet}
ページ取得: ${s.fetched ? '成功' : '失敗（本文なし）'}
ページタイトル: ${s.title || '-'}
ページ本文抜粋: ${s.fetched ? (s.excerpt || '').slice(0, 1800) : '(取得できず)'}`;
  }).join('\n\n---\n\n');

  let detail = { summary: '', shops: [] };
  try {
    detail = await parseJson({
      schemaName: 'shop_analysis',
      schema: DetailSchema,
      effort: 'high',
      maxTokens: 16000,
      system: BUSINESS_CONTEXT,
      prompt: `以下は候補サイトの検索結果と、実際に取得したページ本文です。各候補について日本語で評価してください。

重要なルール:
- 判断は「ページ本文抜粋」に実際に書かれている内容のみを根拠にしてください。書かれていないことを推測で埋めないでください。
- ページ取得が失敗している候補は、検索スニペットだけが根拠です。その場合 is_real_shop の判断は控えめにし、evidence に「スニペットのみ」と書いてください。
- evidence には判断の根拠になったページ上の記述を原文のまま短く引用してください。引用できない場合は空文字にしてください。
- buys_used_stock は「中古在庫を仕入れている形跡があるか」です（buy/sell/trade-in/we buy などの記述）。
- 連絡先（メール・SNS）は別途こちらで抽出済みなので、あなたは出力しないでください。
- relevance_score は1〜5。Kenja Games の卸先としての有望度です。
- 全候補を漏れなく返してください。

${detailInput}`,
    });
  } catch (e) {
    console.error('detail analysis failed:', e.message);
  }

  const detailByIndex = new Map((detail.shops || []).map(s => [s.index, s]));

  const results = toScrape.map(c => {
    const r = deduped[c.index];
    const s = scrapeByIndex.get(c.index) || {};
    const d = detailByIndex.get(c.index) || {};
    return {
      company_name: d.company_name || s.title || r.title,
      country: d.country || r.country,
      angle: r.angle,
      category: d.category || r.angle,
      source_url: r.url,
      website: hostOf(r.url) ? `https://${hostOf(r.url)}` : '',
      // ↓ ここから下はすべてページHTMLからの実測値。AIは関与しない
      verified: !!s.fetched,
      email: s.email || '',
      emails: s.emails || [],
      instagram: s.instagram || '',
      facebook: s.facebook || '',
      twitter: s.twitter || '',
      whatsapp: s.whatsapp || '',
      // ↓ ここから下はAIの判断
      products: d.products || r.snippet,
      is_real_shop: d.is_real_shop ?? null,
      buys_used_stock: d.buys_used_stock || 'unknown',
      direct_score: d.direct_score || 'C',
      relevance_score: d.relevance_score || 0,
      reason: d.reason || '',
      evidence: d.evidence || '',
    };
  });

  // 連絡手段が実測できた店を優先し、その中で有望度順
  results.sort((a, b) => {
    const ac = (a.email || a.instagram || a.whatsapp) ? 1 : 0;
    const bc = (b.email || b.instagram || b.whatsapp) ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return (b.relevance_score || 0) - (a.relevance_score || 0);
  });

  return res.status(200).json({
    results,
    summary: detail.summary || '',
    combos: combos.length,
    total: results.length,
    stats: {
      rawResults: rawResults.length,
      uniqueDomains: deduped.length,
      scraped: results.filter(r => r.verified).length,
      withContact: results.filter(r => r.email || r.instagram || r.whatsapp).length,
    },
  });
};
