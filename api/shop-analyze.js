// Shop Finder の第2段階：業態の説明と評価。
//
// 1リクエストで全候補を分析すると Vercel の60秒上限を超える（実測60.6秒）。
// このエンドポイントは「1バッチぶん」だけを担当し、
// 画面側が候補を小さく割って並列に投げる。件数が増えても頭打ちにならない。
//
// 連絡先（メール・SNS）は shop-search が HTML から実測した値をそのまま通す。
// ここでAIに作らせることは一切しない（スキーマにも入れていない）。
const { z } = require('zod');
const { parseJson } = require('../lib/claude');

const MAX_BATCH = 8;
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

const RULES = `重要なルール:
- 判断は「ページ本文抜粋」に実際に書かれている内容のみを根拠にしてください。書かれていないことを推測で埋めないでください。
- ページ取得が失敗している候補は、検索スニペットだけが根拠です。その場合 is_real_shop の判断は控えめにし、evidence に「スニペットのみ」と書いてください。
- evidence には判断の根拠になったページ上の記述を原文のまま短く引用してください。引用できない場合は空文字にしてください。
- company_name は改行を含めず、店名だけを短く書いてください。
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
  if (candidates.length > MAX_BATCH) {
    return res.status(400).json({ error: `1リクエストは ${MAX_BATCH} 件までです（画面側で分割してください）` });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が未設定です' });
  }

  try {
    // 提供済みの本文に基づく抽出と評価なので、深い思考より応答時間を優先する。
    const out = await parseJson({
      schemaName: 'shop_analysis',
      schema: ShopsSchema,
      effort: 'medium',
      maxTokens: 10000,
      system: BUSINESS_CONTEXT,
      prompt: `以下は候補サイトの検索結果と、実際に取得したページ本文です。各候補について日本語で評価してください。

${RULES}

${candidates.map(describe).join('\n\n---\n\n')}`,
    });

    const byIndex = new Map((out.shops || []).map(s => [s.index, s]));

    const results = candidates.map(c => {
      const d = byIndex.get(c.index) || {};
      return {
        index: c.index,
        company_name: (d.company_name || c.company_name || '').replace(/\s+/g, ' ').trim(),
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

    return res.status(200).json({ results });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
