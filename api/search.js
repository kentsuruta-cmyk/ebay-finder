const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { keyword, globalId, itemsPerPage = 50, minFeedback = 0 } = req.query;

  if (!keyword || !globalId) {
    return res.status(400).json({ error: 'Missing required parameters: keyword, globalId' });
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Missing API credentials' });
  }

  try {
    // Step 1: Get OAuth token
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(500).json({ error: 'Failed to get access token', details: tokenData });
    }

    const accessToken = tokenData.access_token;

    // Step 2: Search items via Browse API (exclude Japan shipments)
    const marketplaceId = globalId.replace('EBAY-', 'EBAY_');
    const searchUrl = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keyword)}&limit=${itemsPerPage}&filter=buyingOptions:{FIXED_PRICE},excludeCountries:{JP}`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
        'Content-Type': 'application/json',
      }
    });

    const searchData = await searchRes.json();

    if (!searchData.itemSummaries) {
      return res.status(200).json({ sellers: [] });
    }

    // Step 3: Extract seller info, exclude JP shippers, aggregate
    const sellerMap = {};
    for (const item of searchData.itemSummaries) {
      const seller = item.seller;
      if (!seller) continue;

      // Double-check: exclude items shipped from Japan
      const shipFrom = item.itemLocation?.country;
      if (shipFrom === 'JP') continue;

      const name = seller.username;
      const feedback = seller.feedbackScore || 0;

      if (feedback < parseInt(minFeedback)) continue;

      if (!sellerMap[name]) {
        sellerMap[name] = {
          username: name,
          feedbackScore: feedback,
          feedbackPercentage: seller.feedbackPercentage || 'N/A',
          itemCount: 0,
          shipFrom: shipFrom || 'N/A',
        };
      }
