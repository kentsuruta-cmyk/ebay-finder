// あるセラーの出品について、米国の買い手に表示される「到着予定日」を集める。
//
// 到着予定が今日から何日後に置かれているかで、在庫を持って売っているか（発送が早い）、
// 売れてから仕入れているか（発送までの日数を長く取る）の見当がつく。
// 日本から商品ページを開くと到着予定は表示されないので、米国の郵便番号を指定してAPIで取る。
const { getToken } = require('../lib/ebay');

const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const { username, keyword = 'pen', zip = '10001', pages = '3' } = req.query;
  if (!username) return res.status(400).json({ error: 'username は必須です' });

  try {
    const token = await getToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      // 買い手の所在地。これを付けると送料と到着予定日がその宛先向けに計算されて返る
      'X-EBAY-C-ENDUSERCTX': `contextualLocation=${encodeURIComponent(`country=US,zip=${zip}`)}`,
    };

    const n = Math.min(Math.max(parseInt(pages, 10) || 1, 1), 10);
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const params = new URLSearchParams({
          q: keyword, limit: '200', offset: String(i * 200), filter: `sellers:{${username}}`, fieldgroups: 'EXTENDED',
        });
        return fetch(`${SEARCH_URL}?${params}`, { headers }).then(async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d?.errors?.[0]?.message || `HTTP ${r.status}`);
          return d;
        });
      })
    );

    const now = Date.now();
    const days = (iso) => (iso ? Math.round(((new Date(iso).getTime() - now) / 864e5) * 10) / 10 : null);
    const items = [];
    for (const d of results) {
      for (const it of d.itemSummaries || []) {
        const opt = (it.shippingOptions || [])[0] || {};
        items.push({
          title: (it.title || '').slice(0, 80),
          price: it.price ? parseFloat(it.price.value) : null,
          shipping: opt.shippingCost ? parseFloat(opt.shippingCost.value) : null,
          minDate: opt.minEstimatedDeliveryDate || null,
          maxDate: opt.maxEstimatedDeliveryDate || null,
          minDays: days(opt.minEstimatedDeliveryDate),
          maxDays: days(opt.maxEstimatedDeliveryDate),
          url: it.itemWebUrl,
        });
      }
    }

    // 「いちばん早い到着予定が何日後か」ごとの点数
    const hist = {};
    let withDate = 0;
    for (const it of items) {
      if (it.minDays == null) continue;
      withDate++;
      const k = Math.round(it.minDays);
      hist[k] = (hist[k] || 0) + 1;
    }

    return res.status(200).json({
      username,
      keyword,
      total: results[0].total || 0,
      read: items.length,
      withDate,
      over21: items.filter((i) => i.minDays != null && i.minDays >= 21).length,   // 3週間以降
      within10: items.filter((i) => i.minDays != null && i.minDays <= 10).length, // 10日以内
      histogramMinDays: hist,
      samples: items.slice(0, 12),
      slowest: [...items].filter((i) => i.minDays != null).sort((a, b) => b.minDays - a.minDays).slice(0, 8),
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
