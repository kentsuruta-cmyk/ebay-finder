const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { appId, keyword, globalId, itemsPerPage = 100 } = req.query;

  if (!appId || !keyword || !globalId) {
    return res.status(400).json({ error: 'Missing required parameters: appId, keyword, globalId' });
  }

  const url =
    'https://svcs.ebay.com/services/search/FindingService/v1' +
    '?OPERATION-NAME=findItemsAdvanced' +
    '&SERVICE-VERSION=1.13.0' +
    '&SECURITY-APPNAME=' + encodeURIComponent(appId) +
    '&RESPONSE-DATA-FORMAT=JSON' +
    '&REST-PAYLOAD' +
    '&GLOBAL-ID=' + encodeURIComponent(globalId) +
    '&keywords=' + encodeURIComponent(keyword) +
    '&categoryId=139971' +
    '&itemFilter(0).name=ExcludeLocation&itemFilter(0).value=JP' +
    '&paginationInput.entriesPerPage=' + encodeURIComponent(itemsPerPage) +
    '&outputSelector(0)=SellerInfo';

  try {
    const ebayRes = await fetch(url);
    const data = await ebayRes.json();
    return res.status(ebayRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
