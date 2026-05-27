const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Missing query parameter' });

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing Serper API key' });

  const REGIONS = [
    { label: 'North America', gl: 'us', query: `${query} -site:ebay.com -site:yelp.com -site:reddit.com -site:youtube.com` },
    { label: 'Europe',        gl: 'gb', query: `${query} Europe -site:ebay.com -site:yelp.com -site:reddit.com -site:youtube.com` },
    { label: 'Oceania',       gl: 'au', query: `${query} -site:ebay.com -site:yelp.com -site:reddit.com -site:youtube.com` },
    { label: 'Middle East',   gl: 'ae', query: `${query} -site:ebay.com -site:yelp.com -site:reddit.com -site:youtube.com` },
  ];

  const results = [];

  for (const region of REGIONS) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: region.query,
          gl: region.gl,
          hl: 'en',
          num: 10,
        }),
      });
      const data = await r.json();
      if (data.organic) {
        for (const item of data.organic) {
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
