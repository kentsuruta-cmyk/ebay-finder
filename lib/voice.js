// 営業文の「口調」を決めるところ。AIっぽい文面になる原因は、ほとんどがここ。
//
// ■ いちばん効くのは EXAMPLES を Kenさんが実際に送って返事が来た文面に差し替えること。
//   今入っているのは、口調の方向性を示すためにClaudeが書いた仮のお手本。
//   差し替えるときは、相手の店名などの固有名詞だけ {SHOP} のように伏せればOK。
//
// ■ BANNED は「AIが書いたとすぐ分かる言い回し」。生成後にここで検査し、
//   引っかかったら1回だけ書き直させる（api/message.js）。

const STYLE = `How to write (this matters more than anything else):
- Write like Ken: a busy small-business owner in Tokyo typing a quick note himself. Plain, friendly, direct. Short sentences. Simple words. Slightly informal is fine.
- English is Ken's second language. Keep it natural and correct, but simple. No fancy vocabulary, no marketing tone.
- The first sentence must show you actually looked at THEIR shop: mention one or two concrete things they carry (taken from the shop facts below). Do not praise them. Just say what you saw.
- Then say in one sentence what we can supply that fits what they sell.
- End with one easy question they can answer with "yes" (for example, "Want me to send the list?"). No pressure, no deadlines.
- Never mention eBay, eBay listings, eBay stores or how you found them. Talk about "your shop" or "your store".
- Only use the facts given. Do not invent numbers, prices, discounts, years in business, customer names or anything else.
- No exclamation marks, or at most one in the whole message. No emojis. No bullet points. No em dashes (—) or en dashes (–).
- Do not start with "I hope", "I am writing", "My name is", or "Dear".`;

const LIMITS = {
  instagram: 'Instagram DM: 3 or 4 short sentences, under 400 characters. Start with "Hi" or "Hey". No signature, just "Ken" at the end is fine.',
  facebook: 'Facebook message: 3 or 4 short sentences, under 450 characters. Start with "Hi". End with "Ken from Kenja Games".',
  x: 'X DM: 2 or 3 sentences, under 260 characters. Very short.',
  email: 'Email (also used for their website contact form): subject line under 8 words, plain and specific (no "Partnership opportunity", no "Collaboration"). Body: 4 to 6 short sentences in 2 or 3 short paragraphs, starting with "Hi," or "Hi {their shop name}," and ending with "Thanks," on its own line. Do not write the signature, it is added automatically.',
};

// Claudeが書いた仮のお手本（Kenさんの実際の文面に差し替える）
const EXAMPLES = `Example A (Instagram DM, retro handhelds):
Hi, Ken here from Tokyo. Saw you have a lot of GBA SPs and DS Lites in your shop. I supply tested Japanese handhelds by the lot to game shops in the US and UK. Want me to send this week's list?
Ken

Example B (email, Japan-only new items):
Subject: Japan-only Switch controllers for your shop

Hi,

I saw you carry Switch accessories and a few Japanese import games. I'm Ken, I run a small trading company in Tokyo.

We can get Japan-only controllers and editions, and games with Japanese store bonuses, brand new. Small quantities are fine to start.

Want me to send a list with prices?

Thanks,`;

// AIが書いたと分かる言い回し（小文字で照合）
const BANNED = [
  'i hope this', 'hope you are doing well', "hope you're doing well", 'hope this finds you',
  'i came across', 'i stumbled', 'came across your', 'impressed', 'great fit', 'perfect fit', 'good fit',
  'synergy', 'reach out', 'touch base', 'i wanted to', 'i am writing', "i'm writing to", 'i am reaching',
  'delighted', 'excited to', 'thrilled', 'leverage', 'mutually beneficial', 'partnership opportunity',
  'collaboration opportunity', 'don\'t hesitate', 'do not hesitate', 'look forward to hearing',
  'looking forward to hearing', 'valued', 'esteemed', 'elevate', 'seamless', 'curated', 'dear sir',
  'to whom it may concern', 'furthermore', 'additionally', 'moreover', 'in today\'s', 'game-changer',
  'top-notch', 'high-quality', 'premium quality', 'boost your', 'take your', 'cater to', 'passionate',
  'ebay', 'feel free', 'at your earliest convenience', 'kind regards', 'warm regards', 'best regards',
];

// 文面のAIっぽさ・ルール違反を検査して、問題のリストを返す（空なら合格）
function lint(text, channel) {
  const problems = [];
  const lower = String(text || '').toLowerCase();
  for (const b of BANNED) if (lower.includes(b)) problems.push(`"${b}" を使わない`);
  if (/[—–]/.test(text)) problems.push('ダッシュ（— –）を使わない');
  if ((text.match(/!/g) || []).length > 1) problems.push('感嘆符は1つまで');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) problems.push('絵文字を使わない');
  const max = { instagram: 420, facebook: 470, x: 270 }[channel];
  if (max && text.length > max) problems.push(`${max}文字以内にする（今 ${text.length} 文字）`);
  return problems;
}

module.exports = { STYLE, LIMITS, EXAMPLES, BANNED, lint };
