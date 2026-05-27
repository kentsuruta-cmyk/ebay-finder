const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, shipFrom, markets, feedback, rating, keywords } = req.body;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing API key' });
  }

  const prompt = `You are writing a professional sales outreach email on behalf of Kenja Games, a Japan-based wholesale supplier of retro handheld gaming consoles.

Seller info:
- eBay username: ${username}
- Ships from: ${shipFrom}
- Active markets: ${markets}
- Feedback score: ${feedback} (${rating}%)
- Product keywords they sell: ${keywords}

About Kenja Games:
- Japan-based shop specializing in compact retro handheld consoles
- Sells both JUNK condition and fully working USED units
- Product lineup: Game Boy, Game Boy Color (GBC), Game Boy Advance (GBA), GBA SP, Nintendo DS, 3DS, 3DS LL (Japan import), PSP and similar
- Currently NOT active on eBay (eBay store is on hold)
- Operates via direct B2B transactions through Instagram and WhatsApp
- Instagram: https://www.instagram.com/kenjagames2/
- Previous eBay store for reference/credibility: https://www.ebay.com/str/myj04
- Main clients are in the US, UK, and the Middle East
- Run by Ken from Japan

Rules for the message:
- Write in English only
- This email is sent DIRECTLY to the seller (not through eBay), so you CAN mention Instagram, WhatsApp, and direct trading
- Keep it friendly, professional, and concise (5-6 sentences max)
- Mention you noticed their store and think there could be a good fit
- Include the Instagram link: https://www.instagram.com/kenjagames2/
- Mention the previous eBay store as reference: https://www.ebay.com/str/myj04
- Invite them to reach out via Instagram or email for pricing and availability
- Tailor the message based on what they sell (${keywords})
- Do NOT include a subject line, just the message body

Write the message now:`;

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
      return res.status(500).json({ error: 'Invalid response from AI', details: data });
    }

    return res.status(200).json({ message: data.content[0].text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
