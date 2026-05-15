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

  const prompt = `You are writing a professional sales outreach message on behalf of Kenja Games, a Japanese wholesale supplier of retro handheld gaming consoles.

Seller info:
- eBay username: ${username}
- Ships from: ${shipFrom}
- Active markets: ${markets}
- Feedback score: ${feedback} (${rating}%)
- Product keywords they sell: ${keywords}

About Kenja Games:
- Specializes in retro compact/handheld gaming consoles from Japan
- Sells both JUNK condition and fully working USED units
- Product lineup: GBC, GBA, GBA SP, PSP, DS, 3DS and similar
- Also sells on eBay but primarily does B2B wholesale with game shops overseas
- Store name online: kenjagames2 (ask them to search this online)
- Pricing will be shared upon inquiry

Rules for the message:
- Write in English only
- Keep it friendly, professional, and concise (max 5-6 sentences)
- Do NOT suggest or imply direct/off-platform transactions
- Mention that you noticed their store and think there could be a good fit
- End by asking them to search "kenjagames2" online and reach out
- Do NOT include subject line, just the message body
- Tailor the message based on what they sell (${keywords})

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
