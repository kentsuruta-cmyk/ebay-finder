// セラーの「eBayの外の連絡先」をまとめて調べる。
// 1リクエストで最大4セラー。画面側が上位から小分けにして並列に投げる（Vercelの60秒上限対策）。
const { findSellerContacts } = require('../lib/contact');

const MAX_PER_REQUEST = 4;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return res.status(500).json({ error: 'SERPER_API_KEY が未設定です' });

  const sellers = (req.body?.sellers || []).filter(s => s && s.username).slice(0, MAX_PER_REQUEST);
  if (!sellers.length) return res.status(400).json({ error: 'sellers が空です' });

  const results = await Promise.all(
    sellers.map(s =>
      findSellerContacts(s, { serperKey }).catch(e => ({ username: s.username, error: e.message }))
    )
  );
  return res.status(200).json({ results });
};
