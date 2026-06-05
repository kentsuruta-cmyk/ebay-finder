const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, shipFrom, markets, feedback, rating, keywords } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing API key' });

  // ── Step 1: SNS情報をWeb Searchで取得 ──
  let contactInfo = { web: null, ig: null, fb: null, email: null, wa: null, x: null };
  try {
    const snsPrompt = `Search for the eBay seller "${username}" and find their contact/social media information.
Look for:
1. Their website (HP)
2. Instagram account URL
3. Facebook page URL
4. Contact email address
5. WhatsApp number
6. Twitter/X account URL

Search query suggestions: "${username} eBay seller", "${username} retro games shop", "${username} site:instagram.com", "${username} site:facebook.com"

Respond ONLY with a JSON object like this (no other text, no markdown):
{
  "web": "https://..." or null,
  "ig": "https://instagram.com/..." or null,
  "fb": "https://facebook.com/..." or null,
  "email": "example@email.com" or null,
  "wa": "+1234567890" or null,
  "x": "https://x.com/..." or null
}

If you cannot find a value, use null. Only include confirmed URLs/values.`;

    const snsRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: snsPrompt }]
      })
    });
    const snsData = await snsRes.json();

    // レスポンスからtextブロックを取得してJSONパース
    if (snsData.content) {
      const textBlock = snsData.content.find(b => b.type === 'text');
      if (textBlock && textBlock.text) {
        const clean = textBlock.text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        contactInfo = {
          web:   parsed.web   || null,
          ig:    parsed.ig    || null,
          fb:    parsed.fb    || null,
          email: parsed.email || null,
          wa:    parsed.wa    || null,
          x:     parsed.x     || null,
        };
      }
    }
  } catch (e) {
    // SNS取得失敗してもメッセージ生成は続行
    console.error('SNS fetch error:', e.message);
  }

  // ── Step 2: アウトリーチメッセージ生成 ──
  const snsContext = [
    contactInfo.web   ? `Their website: ${contactInfo.web}` : '',
    contactInfo.ig    ? `Their Instagram: ${contactInfo.ig}` : '',
    contactInfo.fb    ? `Their Facebook: ${contactInfo.fb}` : '',
    contactInfo.email ? `Their email: ${contactInfo.email}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `You are writing a professional sales outreach email on behalf of Kenja Games, a Japan-based wholesale supplier of retro handheld gaming consoles.
Seller info:
- eBay username: ${username}
- Ships from: ${shipFrom}
- Active markets: ${markets}
- Feedback score: ${feedback} (${rating}%)
- Product keywords they sell: ${keywords}
${snsContext ? `Additional info found about this seller:\n${snsContext}` : ''}
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
- This message is sent DIRECTLY to the seller, so you CAN mention Instagram, WhatsApp, and direct trading
- Keep it friendly, professional, and concise (5-6 sentences max)
- Mention you noticed their store and think there could be a good fit
- Include the Instagram link: https://www.instagram.com/kenjagames2/
- Mention the previous eBay store as reference: https://www.ebay.com/str/myj04
- Invite them to reach out via Instagram or email for pricing and availability
- Tailor the message based on what they sell (${keywords})
- If their website or social media was found, subtly reference it to show you've done your research
- Do NOT include a subject line, just the message body
Write the message now:`;

  try {
    const msgRes = await fetch('https://api.anthropic.com/v1/messages', {
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
    const msgData = await msgRes.json();
    if (!msgData.content || !msgData.content[0]) {
      return res.status(500).json({ error: 'Invalid response from AI', details: msgData });
    }
    return res.status(200).json({
      message: msgData.content[0].text,
      contactInfo
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
