// Shop Finder の第2段階：業態の説明と評価。
//
// 以前は検索・ページ取得・分析を1リクエストで回していたが、Vercelの60秒上限を
// 超えて 504 になった（実測60.2秒）。精度を落とさずに収めるため、
//   /api/shop-search  … 検索 → 選別 → ページ本文の取得（連絡先はここで実測）
//   /api/shop-analyze … 取得済みの本文をもとに評価（このファイル）
// の2段階に分けている。
//
// 連絡先（メール・SNS）は shop-search が HTML から実測した値をそのまま通す。
// ここでAIに作らせることは一切しない。
const { z } = require('zod');
const { parseJson } = require('../lib/claude');

const CHUNK_SIZE = 7;        // 1リクエストあたりの候補数。小さく割って並列に流す
const EXCERPT_CHARS = 1400;

const BUSINESS_CONTEXT = `Kenja Games は日本の中古・ジャンク携帯ゲーム機（Game Boy / GBC / GBA / GBA SP / DS / 3DS / PSP など）の卸売業者です。
海外の「まとまった数を仕入れてくれる」小売店・リペア店・卸業者を探しています。
情報サイト、ブログ、まとめ記事、マーケットプレイスの出品ページは対象外です。`;

const ShopsSchema = z.object({
  shops: z.array(
    z.object({
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
    })
  ),
});

const SummarySchema = z.object({ summary: z.string() });

const ANALYSIS_RULES = `重要なルール:
- 判断は「ページ本文抜粋」に実際に書かれている内容のみを根拠にしてください。書かれていないことを推測で埋めないでください。
- ページ取得が失敗している候補は、検索スニペットだけが根拠です。その場合 is_real_shop の判断は控えめにし、evidence に「スニペットのみ」と書いてください。
- evidence には判断の根拠になったページ上の記述を原文のまま短く引用してください。引用できない場合は空文字にしてください。
- buys_used_stock は「中古在庫を仕入れている形跡があるか」です（buy / sell / trade-in / we buy などの記述）。
- 連絡先（メール・SNS）は別途こちらで抽出済みなので、あなたは出力しないでください。
- relevance_score は1〜5。Kenja Games の卸先としての有望度です。
- 与えられた候補を漏れなく返してください。index は入力の番号をそのまま使ってください。`;

function describe(c) {
  return `[${c.index}] ${c.country} / ${c.angle}
URL: ${c.source_url}
検索タイトル: ${c.title}
検索スニペット: ${c.snippet}
ページ取得: ${c.verified ? '成功' : '失敗（本文なし）'}
ページタイトル: ${c.page_title || '-'}
ページ本文抜粋: ${c.verified ? (c.excerpt || '').slice(0, EXCERPT_CHARS) : '(取得できず)'}`;
}

async function analyzeChunk(chunk) {
  const out = await parseJson({
    schemaName: 'shop_analysis',
    schema: ShopsSchema,
    effort: 'high',
    maxTokens: 12000,
    system: BUSINESS_CONTEXT,
    prompt: `以下は候補サイトの検索結果と、実際に取得したページ本文です。各候補について日本語で評価してください。

${ANALYSIS_RULES}

${chunk.map(describe).join('\n\n---\n\n')}`,
  });
  return out.shops || [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { candidates } = req.body || {};
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ error: 'candidates が空です' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が未設定です' });
  }

  // 小さく割って並列に流す。1本失敗しても他の結果は返す。
  const chunks = [];
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    chunks.push(candidates.slice(i, i + CHUNK_SIZE));
  }

  const settled = await Promise.all(
    chunks.map(chunk =>
      analyzeChunk(chunk).catch(e => {
        console.error('chunk analysis failed:', e.message);
        return [];
      })
    )
  );
  const analyzed = settled.flat();
  const byIndex = new Map(analyzed.map(s => [s.index, s]));

  const results = candidates.map(c => {
    const d = byIndex.get(c.index) || {};
    return {
      company_name: d.company_name || c.company_name,
      country: d.country || c.country,
      angle: c.angle,
      category: d.category || c.angle,
      source_url: c.source_url,
      website: c.website,
      // ↓ ページHTMLからの実測値。AIは関与しない
      verified: !!c.verified,
      email: c.email || '',
      emails: c.emails || [],
      instagram: c.instagram || '',
      facebook: c.facebook || '',
      twitter: c.twitter || '',
      whatsapp: c.whatsapp || '',
      // ↓ AIの判断
      products: d.products || c.snippet || '',
      is_real_shop: d.is_real_shop ?? null,
      buys_used_stock: d.buys_used_stock || 'unknown',
      direct_score: d.direct_score || 'C',
      relevance_score: d.relevance_score || 0,
      reason: d.reason || '',
      evidence: d.evidence || '',
      analyzed: byIndex.has(c.index),
    };
  });

  // 連絡手段が実測できた店を優先し、その中で有望度順
  results.sort((a, b) => {
    const ac = (a.email || a.instagram || a.whatsapp) ? 1 : 0;
    const bc = (b.email || b.instagram || b.whatsapp) ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return (b.relevance_score || 0) - (a.relevance_score || 0);
  });

  // 総括は短い入力で1回だけ
  let summary = '';
  try {
    const s = await parseJson({
      schemaName: 'shop_summary',
      schema: SummarySchema,
      effort: 'low',
      maxTokens: 2000,
      system: BUSINESS_CONTEXT,
      prompt: `以下は調査した海外の潜在取引先です。日本語で250字程度の総括を書いてください。
国別の特徴、有望な相手の傾向、連絡手段の取りやすさに触れてください。リストに無いことは書かないでください。

${results
  .map(r => `${r.country} / ${r.company_name}（${r.category}）有望度${r.relevance_score} 直取${r.direct_score} 仕入${r.buys_used_stock} 連絡先${r.email || r.instagram || r.whatsapp ? 'あり' : 'なし'}`)
  .join('\n')}`,
    });
    summary = s.summary || '';
  } catch (e) {
    console.error('summary failed:', e.message);
  }

  return res.status(200).json({
    results,
    summary,
    total: results.length,
    analyzedCount: results.filter(r => r.analyzed).length,
  });
};
