// セラー個別のアウトリーチ文面生成。
// 旧実装はWeb検索の結果をClaudeにJSONで出させて、それをそのまま連絡先として表示していた。
// 新実装は「Web検索で公式サイトを特定 → そのサイトのHTMLから連絡先を実測」の順にし、
// AI由来の値と実測値をUIで区別できるようにした（verified フラグ）。
const { z } = require('zod');
const { parseJson, text } = require('../lib/claude');
const { scrapeSite } = require('../lib/scrape');

const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 6 };

const SiteSchema = z.object({
  website: z.string(),          // 見つからなければ空文字
  instagram: z.string(),
  facebook: z.string(),
  twitter: z.string(),
  email: z.string(),
  whatsapp: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  note: z.string(),
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, shipFrom, markets, feedback, rating, keywords } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username は必須です' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY が未設定です' });

  let contactInfo = {
    web: null, ig: null, fb: null, email: null, wa: null, x: null,
    verified: false, confidence: 'low', note: '',
  };

  // ── Step 1: Web検索でこのセラーの自社サイト・SNSを特定 ──
  let searchNotes = '';
  try {
    searchNotes = await text({
      tools: [WEB_SEARCH_TOOL],
      effort: 'medium',
      maxTokens: 4000,
      prompt: `Find the official website and social media accounts of the eBay seller "${username}" (ships from ${shipFrom || 'unknown'}, sells: ${keywords || 'retro games'}).

Search for their eBay store page, their own webshop, and their Instagram / Facebook / X accounts.
Report only what you actually found in search results, with the URLs. If you could not find something, say so explicitly.
Do not guess or construct URLs.`,
    });
  } catch (e) {
    console.error('web search failed:', e.message);
  }

  // ── Step 2: 検索結果テキストからURLを構造化して取り出す ──
  if (searchNotes) {
    try {
      const parsed = await parseJson({
        schemaName: 'seller_site',
        schema: SiteSchema,
        effort: 'low',
        maxTokens: 2000,
        prompt: `以下は eBay セラー "${username}" について Web 検索した結果のメモです。ここに実際に書かれている URL だけを抜き出してください。
書かれていないものは必ず空文字にしてください。URLを組み立てたり推測したりしないでください。

${searchNotes}`,
      });
      contactInfo = {
        web: parsed.website || null,
        ig: parsed.instagram || null,
        fb: parsed.facebook || null,
        x: parsed.twitter || null,
        email: parsed.email || null,
        wa: parsed.whatsapp || null,
        verified: false,
        confidence: parsed.confidence,
        note: parsed.note || '',
      };
    } catch (e) {
      console.error('site parse failed:', e.message);
    }
  }

  // ── Step 3: 公式サイトが分かったら、実際に開いて連絡先を確定させる ──
  if (contactInfo.web) {
    try {
      const s = await scrapeSite(contactInfo.web);
      if (s.fetched) {
        contactInfo = {
          ...contactInfo,
          email: s.email || contactInfo.email,
          ig: s.instagram || contactInfo.ig,
          fb: s.facebook || contactInfo.fb,
          x: s.twitter || contactInfo.x,
          wa: s.whatsapp || contactInfo.wa,
          verified: true,   // サイトのHTMLから実測できた
        };
      }
    } catch (e) {
      console.error('scrape failed:', e.message);
    }
  }

  // ── Step 4: 文面生成 ──
  const snsContext = [
    contactInfo.web ? `Their website: ${contactInfo.web}` : '',
    contactInfo.ig ? `Their Instagram: ${contactInfo.ig}` : '',
    contactInfo.fb ? `Their Facebook: ${contactInfo.fb}` : '',
    contactInfo.email ? `Their email: ${contactInfo.email}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `You are writing a professional sales outreach email on behalf of Kenja Games, a Japan-based wholesale supplier of retro handheld gaming consoles.

Seller info:
- eBay username: ${username}
- Ships from: ${shipFrom}
- Active markets: ${markets}
- Feedback score: ${feedback} (${rating}%)
- Product keywords they sell: ${keywords}
${snsContext ? `\nConfirmed info about this seller:\n${snsContext}` : ''}

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
- Only reference their website or social media if it is listed under "Confirmed info" above. Never invent details about their business.
- Do NOT include a subject line, just the message body

Write the message now:`;

  try {
    const message = await text({ prompt, effort: 'medium', maxTokens: 2000 });
    return res.status(200).json({ message, contactInfo });
  } catch (err) {
    return res.status(500).json({ error: err.message, contactInfo });
  }
};
