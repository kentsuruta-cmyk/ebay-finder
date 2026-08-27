// 調査結果の総括。入力は各社1行のダイジェストだけなので軽い。
// 分析本体（shop-analyze）と分けてあるのは、総括を待つあいだ表が出ないのを避けるため。
const { z } = require('zod');
const { parseJson } = require('../lib/claude');

const SummarySchema = z.object({ summary: z.string() });

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { results } = req.body || {};
  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: 'results が空です' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が未設定です' });
  }

  try {
    const digest = results
      .slice(0, 60)
      .map(r =>
        `${r.country} / ${r.company_name}（${r.category}）有望度${r.relevance_score} 直取${r.direct_score} 仕入${r.buys_used_stock} 連絡先${r.email || r.instagram || r.whatsapp ? 'あり' : 'なし'}`
      )
      .join('\n');

    const out = await parseJson({
      schemaName: 'shop_summary',
      schema: SummarySchema,
      effort: 'low',
      maxTokens: 2000,
      system: `Kenja Games は日本の中古・ジャンク携帯ゲーム機の卸売業者で、海外の仕入先候補を探しています。`,
      prompt: `以下は調査した海外の潜在取引先です。日本語で250字程度の総括を書いてください。
国別の特徴、有望な相手の傾向、連絡手段の取りやすさに触れてください。リストに無いことは書かないでください。

${digest}`,
    });

    return res.status(200).json({ summary: out.summary || '' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
