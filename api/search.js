// eBayセラー検索。
// 旧実装との違い:
//  - 1ページ(最大200件)しか見ていなかったのをページング化（母数が10〜50倍）
//  - カテゴリ／コンディションで絞り込めるようにした
//  - eBay側のエラーを握りつぶさず返す（旧実装は 0件 と区別がつかなかった）
//  - セラーごとに出品タイトルのサンプルを返し、何を扱う店か判断できるようにした
const { searchItems } = require('../lib/ebay');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    keyword,
    globalId,
    maxItems = 600,
    minFeedback = 0,
    categoryIds = '',
    conditionIds = '',
    excludeCountries = 'JP',
  } = req.query;

  if (!keyword || !globalId) {
    return res.status(400).json({ error: 'keyword と globalId は必須です' });
  }

  const excluded = String(excludeCountries).split(',').map(s => s.trim()).filter(Boolean);
  const minFb = parseInt(minFeedback, 10) || 0;

  try {
    const { items, total, categoryFallback } = await searchItems({
      globalId,
      keyword,
      maxItems: Math.min(parseInt(maxItems, 10) || 600, 2000),
      categoryIds: categoryIds || undefined,
      conditionIds: conditionIds ? conditionIds.split(',').filter(Boolean) : undefined,
    });

    const sellerMap = {};
    let excludedCount = 0;

    for (const item of items) {
      const seller = item.seller;
      if (!seller || !seller.username) continue;

      const feedback = seller.feedbackScore || 0;
      if (feedback < minFb) continue;

      const shipFrom = item.itemLocation ? item.itemLocation.country : null;
      if (shipFrom && excluded.includes(shipFrom)) { excludedCount++; continue; }

      const name = seller.username;
      if (!sellerMap[name]) {
        sellerMap[name] = {
          username: name,
          feedbackScore: feedback,
          feedbackPercentage: seller.feedbackPercentage || 'N/A',
          hits: 0,                 // この検索結果プール内で何点ヒットしたか（出品総数ではない）
          shipFrom: shipFrom || '?',
          sampleTitles: [],
          priceSum: 0,
          priceCount: 0,
          currency: '',
        };
      }
      const s = sellerMap[name];
      s.hits++;
      if (s.sampleTitles.length < 4 && item.title) s.sampleTitles.push(item.title.slice(0, 90));

      const p = item.price && parseFloat(item.price.value);
      if (p && !Number.isNaN(p)) {
        s.priceSum += p;
        s.priceCount++;
        s.currency = item.price.currency || s.currency;
      }
    }

    const sellers = Object.values(sellerMap).map(s => ({
      ...s,
      avgPrice: s.priceCount ? Math.round((s.priceSum / s.priceCount) * 100) / 100 : null,
      priceSum: undefined,
      priceCount: undefined,
    }));

    return res.status(200).json({
      sellers,
      total: sellers.length,
      scanned: items.length,          // 実際に読んだ出品数
      available: total,               // eBay側の総ヒット数
      excludedCount,
      categoryFallback: !!categoryFallback,   // カテゴリIDが通らずカテゴリ無しで再検索した
    });
  } catch (err) {
    // 旧実装はここで {sellers: []} を返していたので、画面上は「0件」と区別がつかなかった
    return res.status(502).json({ error: err.message, sellers: [] });
  }
};
