const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { angles, countries } = req.body;
  if (!angles || !angles.length || !countries || !countries.length) {
    return res.status(400).json({ error: 'Missing angles or countries' });
  }

  const serperKey = process.env.SERPER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!serperKey) return res.status(500).json({ error: 'Missing Serper API key' });
  if (!anthropicKey) return res.status(500).json({ error: 'Missing Anthropic API key' });

  // 最大12コンボ
  const combos = [];
  for (const angle of angles) {
    for (const country of countries) {
      combos.push({ angle, country });
      if (combos.length >= 12) break;
    }
    if (combos.length >= 12) break;
  }

  // Step1: Serperで検索
  const rawResults = [];
  for (const { angle, country } of combos) {
    try {
      const q = `${angle.query} -site:ebay.com -site:yelp.com -site:reddit.com -site:youtube.com -site:amazon.com`;
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, gl: country.gl, hl: 'en', num: 5 }),
      });
      const data = await r.json();
      if (data.organic) {
        for (const item of data.organic) {
          rawResults.push({
            region: country.region,
            country: country.label,
            angle: angle.label,
            title: item.title,
            url: item.link,
            snippet: item.snippet || '',
          });
        }
      }
    } catch (e) {
      console.error(`Serper error: ${angle.label} / ${country.label}:`, e);
    }
  }

  // URLでdedup
  const seen = new Set();
  const deduped = rawResults.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url); return true;
  });

  if (deduped.length === 0) {
    return res.status(200).json({ results: [], summary: '', combos: combos.length });
  }

  // Step2: ClaudeでAI分析
  const analysisPrompt = `You are helping a Japanese wholesale buyer of retro handheld gaming consoles (Game Boy, GBA, GBA SP, DS, PSP etc.) find overseas B2B trading partners.

Below are Google search results. Analyze each result and extract structured information about each potential business partner.

Search results:
${deduped.map((r, i) => `[${i}] Country: ${r.country} | Angle: ${r.angle}
Title: ${r.title}
URL: ${r.url}
Snippet: ${r.snippet}`).join('\n\n')}

For each result, provide a JSON object with:
- index: (number, matching the [N] above)
- company_name: company or shop name (in original language if possible)
- country: country label
- category: short business category in Japanese (e.g. "Game Boy 修理・リストア専門店")
- source_url: the URL
- website: homepage URL if identifiable, else ""
- instagram: Instagram URL if found in title/snippet/url, else ""
- facebook: Facebook URL if found, else ""
- twitter: Twitter/X URL if found, else ""
- email: email if found, else ""
- whatsapp: WhatsApp number if found, else ""
- ebay: eBay store URL if found, else ""
- price_range: price range info if mentioned, else ""
- products: what products/services they handle in Japanese (1-2 sentences)
- direct_score: "A" (easy to contact directly), "B" (possible), or "C" (difficult)
- reason: why they are a good match in Japanese (1-2 sentences)
- relevance_score: 1-5 integer

Respond ONLY with a JSON array, no markdown, no other text.`;

  let analyzedSellers = [];
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: analysisPrompt }]
      })
    });
    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) analyzedSellers = JSON.parse(match[0]);
  } catch (e) {
    console.error('Claude analysis error:', e);
    // フォールバック：生データをそのまま返す
    analyzedSellers = deduped.map((r, i) => ({
      index: i, company_name: r.title, country: r.country,
      category: r.angle, source_url: r.url,
      website: '', instagram: '', facebook: '', twitter: '',
      email: '', whatsapp: '', ebay: '',
      price_range: '', products: r.snippet,
      direct_score: 'B', reason: '', relevance_score: 3
    }));
  }

  // Step3: AIサマリー生成
  let summary = '';
  try {
    const summaryPrompt = `以下は海外の潜在取引先セラーのリストです。日本語で200字程度の簡潔なサマリーを書いてください。国別の特徴、有望なセラーの傾向、連絡手段の傾向を含めてください。

${analyzedSellers.map(s => `${s.country}: ${s.company_name} (${s.category}) 直取スコア:${s.direct_score}`).join('\n')}`;

    const sumRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: summaryPrompt }]
      })
    });
    const sumData = await sumRes.json();
    summary = sumData.content?.[0]?.text || '';
  } catch (e) {
    console.error('Summary error:', e);
  }

  // relevance_scoreでソート
  analyzedSellers.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

  return res.status(200).json({
    results: analyzedSellers,
    summary,
    combos: combos.length,
    total: analyzedSellers.length
  });
};
