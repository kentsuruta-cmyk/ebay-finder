// 国内の相場。メルカリで「売り切れ」になった出品＝実際に売れた値段を見る。
//
// 商品ふるい分けの「仕入れ上限」は、海外セラーの売値から逆算した「ここまでなら払える」額。
// それが意味を持つかどうかは、国内で実際にいくらで買えるか次第なので、その値段を取りに行く。
const { searchMercari } = require('../lib/mercari');

const quantile = (sorted, p) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const { keyword, priceMin = '3000' } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword は必須です' });

  try {
    // 最低価格は付属品・部品を外すため。メルカリは出品の新しい順に最大120件。
    const data = await searchMercari({ keyword, status: 'STATUS_SOLD_OUT', priceMin: parseInt(priceMin, 10) || 0 });
    const items = (data.items || [])
      .map((i) => ({ title: i.name || '', price: Number(i.price) || 0, created: Number(i.created) || 0, updated: Number(i.updated) || 0, id: i.id }))
      .filter((i) => i.price > 0);

    const prices = items.map((i) => i.price).sort((a, b) => a - b);
    // 売れ行きの目安: 返ってきた売り切れ品が、何日ぶんの出品にあたるか。
    // （新しい順に120件が上限なので、120件が短い期間に収まるほどよく売れている）
    const now = Date.now() / 1000;
    // 並びは完全な新着順ではなく古い出品が混ざるので、新しいほうから8割の位置にある出品の経過日数で測る。
    const ages = items.map((i) => (now - i.created) / 86400).sort((a, b) => a - b);
    const covered = Math.floor(ages.length * 0.8);
    const spanDays = covered > 0 ? Math.max(ages[covered - 1], 0.5) : null;

    return res.status(200).json({
      keyword,
      count: items.length,
      p25: quantile(prices, 0.25),
      median: quantile(prices, 0.5),
      p75: quantile(prices, 0.75),
      spanDays: spanDays == null ? null : Math.round(spanDays * 10) / 10,
      soldPerDay: spanDays ? Math.round((covered / spanDays) * 10) / 10 : null,
      capped: items.length >= 120,   // 上限に当たっている＝実際はもっと売れている可能性がある
      samples: items.slice(0, 8).map((i) => ({ title: i.title.slice(0, 60), price: i.price, url: `https://jp.mercari.com/item/${i.id}` })),
    });
  } catch (err) {
    return res.status(502).json({ error: err.message, keyword });
  }
};
