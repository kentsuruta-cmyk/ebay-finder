const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { angles, countries } = req.body;
  // angles: [{ label, query }, ...]
  // countries: [{ label, gl, region }, ...]

  if (!angles || !angles.length || !countries || !countries.length) {
    return res.status(400).json({ error: 'Missing angles or countries' });
  }

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing Serper API key' });

  // 最大12コンボに制限（コスト/時間ガード）
  const combos = [];
  for (const angle of angles) {
    for (const country of countries) {
      combos.push({ angle, country });
      if (combos.length >= 12) break;
    }
    if (combos.length >= 12) break;
  }

  const results = [];
  for (const { angle, country } of combos) {
    try {
      const q = `${angle.query} -site:ebay.com -site:yelp.com -site:reddit.com -site:youtube.com -site:amazon.com`;
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q,
          gl: country.gl,
          hl: 'en',
          num: 5,
        }),
      });
      const data = await r.json();
      if (data.organic) {
        for (const item of data.organic) {
          results.push({
            region: country.region,
            country: country.label,
            angle: angle.label,
            title: item.title,
            url: item.link,
            snippet: item.snippet,
            isInstagram: item.link.includes('instagram.com'),
            isFacebook: item.link.includes('facebook.com'),
            isEbay: item.link.includes('ebay.'),
            isEtsy: item.link.includes('etsy.com'),
          });
        }
      }
    } catch (e) {
      console.error(`Error for ${angle.label} / ${country.label}:`, e);
    }
  }

  // URLでdedup
  const seen = new Set();
  const deduped = results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  return res.status(200).json({ results: deduped, total: deduped.length, combos: combos.length });
};
