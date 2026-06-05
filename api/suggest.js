const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: 'Missing keyword' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing API key' });

  const prompt = `You are helping a Japanese wholesale buyer of retro handheld gaming consoles find overseas B2B trading partners.

The user wants to search for: "${keyword}"

Generate 6-8 search angle suggestions for finding RETAILERS and WHOLESALERS (NOT information sites, blogs, or marketplaces like eBay/Amazon).

Each angle should represent a different TYPE of business partner:
- Specialty retail shops
- Online resellers
- Wholesale/bulk buyers
- Import/export dealers
- Game shop chains
- Flea market / second-hand dealers
- etc.

For each angle, provide:
1. A short Japanese label (e.g. "専門小売店")
2. A short description in Japanese explaining what type of shop this targets
3. An optimized English search query string (for Google) that would find that type of shop

Respond ONLY with a JSON array, no markdown, no other text:
[
  {
    "label": "専門小売店",
    "description": "レトロゲーム専門の小売店・実店舗",
    "query": "${keyword} specialty retro game shop store buy sell"
  },
  ...
]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (!data.content || !data.content[0]) {
      return res.status(500).json({ error: 'Invalid response from AI', details: JSON.stringify(data) });
    }
    const text = data.content[0].text;
    // JSON配列を抽出（前後の説明文を除去）
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return res.status(500).json({ error: 'Could not parse JSON array', raw: text.slice(0, 300) });
    }
    const angles = JSON.parse(match[0]);
    return res.status(200).json({ angles });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
