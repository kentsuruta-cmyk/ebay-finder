// 営業文の生成（連絡先ごと：メール／問い合わせフォーム・Instagram・Facebook・X）。
//
// 2026-11 作り直し:
//  - eBay内のメッセージは使わない（直接取引に誘うとアカウントが止まる）。eBayのことは文面に一切書かない
//  - 連絡先探しは /api/contact に分離（ここではWeb検索しない → 速く安くなった）
//  - 相手の店で実際に扱っている商品（出品タイトル・HPの本文）に触れて、定型文に見えないようにする
//  - 書いたあと lib/voice.js の禁止語リストで検査し、引っかかったら1回だけ書き直させる
//  - 「売り込む商品」を切り替えられる（レトロ小型機／日本限定の新品）
const { z } = require('zod');
const { parseJson, WRITER_MODEL } = require('../lib/claude');
const { getPitch, SIGNATURE } = require('../lib/business');
const { STYLE, LIMITS, EXAMPLES, lint } = require('../lib/voice');

const DraftSchema = z.object({
  shop_name: z.string(),        // 文面で呼びかけに使う店名（分からなければ空文字）
  hook: z.string(),             // 1文目で触れた「相手の店の具体的なこと」（日本語で短く。画面での確認用）
  email_subject: z.string(),
  email_body: z.string(),
  instagram: z.string(),
  facebook: z.string(),
  x: z.string(),
});

const CHANNELS = ['email', 'instagram', 'facebook', 'x'];

function shopFacts(t) {
  const lines = [];
  if (t.name) lines.push(`- Name / handle: ${t.name}`);
  if (t.siteTitle) lines.push(`- Their website title: ${t.siteTitle}`);
  if (t.country) lines.push(`- Country: ${t.country}`);
  if (t.products) lines.push(`- What they sell (from their website): ${t.products}`);
  if (t.sampleTitles?.length) lines.push(`- Some items they currently sell:\n${t.sampleTitles.slice(0, 6).map(x => `  * ${x}`).join('\n')}`);
  if (t.japanSignals?.length) lines.push(`- Their website mentions: ${t.japanSignals.join(', ')} (they already sell Japanese imports)`);
  if (t.siteExcerpt) lines.push(`- Text from their website (excerpt):\n"""${String(t.siteExcerpt).slice(0, 700)}"""`);
  return lines.join('\n') || '- (almost nothing known)';
}

function buildPrompt(target, pitch) {
  return `Write first-contact sales messages from Ken (Kenja Games, Tokyo) to a game shop abroad. Ken wants them to start buying from him directly, by the lot.

What we offer (use only these facts):
${pitch.facts}
What to offer at the end: ${pitch.offer}

About their shop (use only these facts):
${shopFacts(target)}

${STYLE}

Write one version for each channel:
- ${LIMITS.email}
- ${LIMITS.instagram}
- ${LIMITS.facebook}
- ${LIMITS.x}

Each version should read like Ken wrote it separately for that app, not like the same text cut shorter.
If the shop's real name is clear from the facts (website title or name), put it in shop_name and you may use it once. Otherwise leave shop_name empty and do not guess a name.
In "hook", write in Japanese what concrete thing about their shop you mentioned in the first sentence.

Tone reference (follow the voice, do not copy the wording):
${EXAMPLES}`;
}

function allProblems(d) {
  const out = {};
  const email = `${d.email_subject}\n${d.email_body}`;
  const p = { email: lint(email, 'email'), instagram: lint(d.instagram, 'instagram'), facebook: lint(d.facebook, 'facebook'), x: lint(d.x, 'x') };
  for (const ch of CHANNELS) if (p[ch].length) out[ch] = p[ch];
  return out;
}

function withSignature(body) {
  const b = String(body || '').trim();
  return /\nKen\s*$/i.test(b) ? b : `${b}\n${SIGNATURE}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY が未設定です' });

  const { target = {}, pitch: pitchKey } = req.body || {};
  if (!target.name) return res.status(400).json({ error: 'target.name は必須です' });
  const pitch = getPitch(pitchKey);

  try {
    const prompt = buildPrompt(target, pitch);
    let draft = await parseJson({
      model: WRITER_MODEL, schemaName: 'outreach', schema: DraftSchema,
      effort: 'medium', maxTokens: 6000, prompt,
    });

    // AIっぽい言い回し・長さ超過があれば、問題点を伝えて1回だけ書き直させる
    let problems = allProblems(draft);
    let rewritten = false;
    if (Object.keys(problems).length) {
      const list = Object.entries(problems).map(([ch, ps]) => `- ${ch}: ${ps.join(' / ')}`).join('\n');
      draft = await parseJson({
        model: WRITER_MODEL, schemaName: 'outreach', schema: DraftSchema,
        effort: 'medium', maxTokens: 6000,
        prompt: `${prompt}

Here is your previous draft. It breaks these rules (Japanese notes, fix all of them):
${list}

Previous draft:
${JSON.stringify(draft, null, 2)}

Rewrite every channel so none of these problems remain. Keep what was good.`,
      });
      problems = allProblems(draft);
      rewritten = true;
    }

    return res.status(200).json({
      hook: draft.hook,
      shopName: draft.shop_name,
      drafts: {
        email: { subject: draft.email_subject, body: withSignature(draft.email_body) },
        instagram: draft.instagram,
        facebook: draft.facebook,
        x: draft.x,
      },
      problems,       // 書き直しても残った問題（画面に注意として出す）
      rewritten,
      pitch: pitchKey || 'retro',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
