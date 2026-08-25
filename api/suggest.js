// 検索アングルの提案。モデル更新 + 構造化出力（旧実装は正規表現でJSONを切り出していた）
const { z } = require('zod');
const { parseJson } = require('../lib/claude');

const AnglesSchema = z.object({
  angles: z.array(z.object({
    label: z.string(),
    description: z.string(),
    query: z.string(),
    target_type: z.enum(['retail', 'repair', 'wholesale', 'import_export', 'chain', 'secondhand', 'other']),
  })),
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { keyword } = req.body || {};
  if (!keyword) return res.status(400).json({ error: 'keyword は必須です' });

  try {
    const out = await parseJson({
      schemaName: 'search_angles',
      schema: AnglesSchema,
      effort: 'medium',
      maxTokens: 8000,
      system: `Kenja Games は日本の中古・ジャンク携帯ゲーム機の卸売業者です。海外で「まとまった数を仕入れてくれる」小売店・リペア店・卸業者を探しています。`,
      prompt: `ユーザーが探したいもの: "${keyword}"

この対象について、Google検索で「実在する店舗の自社サイト」に当たりやすい検索アングルを6〜8個作ってください。

query の作り方（ここが精度を決めます）:
- 店が自分のサイトに書く言葉を使う。例: "we buy", "trade-in", "wholesale inquiries", "bulk", "repair service", "stockist"
- 情報サイトに当たりやすい語（best, top 10, guide, review, history, how to）は避ける
- 引用符でフレーズを固定し、必要なら inurl: や intitle: を使う
- 英語で書く（検索対象は英語圏）
- マーケットプレイス除外は別途こちらで付けるので query には書かない

label と description は日本語で、どういう業態を狙う検索なのかが分かるように書いてください。`,
    });
    return res.status(200).json({ angles: out.angles });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
