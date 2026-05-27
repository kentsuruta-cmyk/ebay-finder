const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Missing query parameter' });

  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  if (!apiKey || !cx) return res.status(500).json({ error: 'Missing Google API credentials' });

  const REGIONS = [
    { label: 'North America', query: `${query} North America` },
    { label: 'Europe',        query: `${query} Europe` },
    { label: 'Oceania',       query: `${query} Australia` },
    { label: 'Middle East',   query: `${query} Middle East` },
  ];

  const results = [];

  for (const region of REGIONS) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(region.query)}&num=10`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.items) {
        for (const item of data.items) {
          results.push({
            region: region.label,
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
      console.error(`Error for region ${region.label}:`, e);
    }
  }

  return res.status(200).json({ results, total: results.length });
};
