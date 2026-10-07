// あるセラーの出品を、同じ検索語の日本発送の出品と「同じ型番どうし」で比べる。
//
// 「このセラーは自分たちと同じものを高く売っているのか」を確かめるためのもの。
// 売値だけだと送料の付け方（送料込み／別）で見え方が変わるので、送料も足した額で比べる。
// 状態（中古・整備済みなど）も一緒に返す。
const { searchItems } = require('../lib/ebay');
const { modelTokens } = require('./screen');

const median = (arr) => {
  const v = arr.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};
const round = (n) => (n == null ? null : Math.round(n * 100) / 100);

function slim(item) {
  const usd = (m) => (m && m.currency === 'USD' ? parseFloat(m.value) : null);
  const price = usd(item.price);
  const ship = item.shippingOptions && item.shippingOptions[0] ? usd(item.shippingOptions[0].shippingCost) : null;
  return {
    title: item.title || '',
    price,
    shipping: ship,                                   // 米国あての送料。取れないときは null
    total: price == null ? null : price + (ship || 0),
    condition: item.condition || '',
    country: item.itemLocation ? item.itemLocation.country : null,
    seller: item.seller ? item.seller.username : null,
    url: item.itemWebUrl || '',
    tokens: modelTokens(item.title),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const { username, keyword, minPrice = '0' } = req.query;
  if (!username || !keyword) return res.status(400).json({ error: 'username と keyword は必須です' });

  const globalId = 'EBAY-US';
  const floor = Math.max(0, parseFloat(minPrice) || 0);
  const priceFilter = floor > 0 ? [`price:[${floor}..]`, 'priceCurrency:USD'] : [];

  try {
    const [mine, jp] = await Promise.all([
      searchItems({ globalId, keyword, maxItems: 600, extraFilters: [...priceFilter, `sellers:{${username}}`] }),
      searchItems({ globalId, keyword, maxItems: 800, extraFilters: [...priceFilter, 'itemLocationCountry:JP'] }),
    ]);
    const sellerItems = mine.items.map(slim).filter((i) => i.price != null);
    const jpItems = jp.items.map(slim).filter((i) => i.price != null);

    const group = (items) => {
      const m = new Map();
      for (const it of items) for (const tk of it.tokens) {
        if (!m.has(tk)) m.set(tk, []);
        m.get(tk).push(it);
      }
      return m;
    };
    const a = group(sellerItems), b = group(jpItems);
    const condCount = (items) => {
      const c = {};
      for (const it of items) c[it.condition || '不明'] = (c[it.condition || '不明'] || 0) + 1;
      return c;
    };

    const models = [];
    for (const [token, list] of a) {
      const other = b.get(token) || [];
      const sm = median(list.map((i) => i.total));
      const jm = other.length ? median(other.map((i) => i.total)) : null;
      models.push({
        token,
        sellerCount: list.length,
        sellerMedianTotal: round(sm),
        sellerMedianPrice: round(median(list.map((i) => i.price))),
        sellerConditions: condCount(list),
        jpCount: other.length,
        jpMedianTotal: round(jm),
        jpMedianPrice: round(other.length ? median(other.map((i) => i.price)) : null),
        jpConditions: condCount(other),
        ratio: jm ? round(sm / jm) : null,
        sample: list.slice(0, 3).map((i) => ({ title: i.title.slice(0, 90), price: i.price, shipping: i.shipping, condition: i.condition })),
        jpSample: other.slice(0, 3).map((i) => ({ title: i.title.slice(0, 90), price: i.price, shipping: i.shipping, condition: i.condition, seller: i.seller })),
      });
    }
    models.sort((x, y) => y.sellerCount - x.sellerCount);

    return res.status(200).json({
      username,
      keyword,
      sellerListings: mine.total,
      jpListings: jp.total,
      sellerConditions: condCount(sellerItems),
      jpConditions: condCount(jpItems),
      sellerMedianTotal: round(median(sellerItems.map((i) => i.total))),
      jpMedianTotal: round(median(jpItems.map((i) => i.total))),
      models: models.slice(0, 40),
      // 型番が読み取れなかった出品も見られるよう、先頭をそのまま返す
      sellerItems: sellerItems.slice(0, 60).map((i) => ({ title: i.title.slice(0, 100), price: i.price, shipping: i.shipping, condition: i.condition, url: i.url })),
      // ?raw=1 … 両方の出品を全部返す（細かく突き合わせたいとき用）
      ...(req.query.raw === '1'
        ? {
            rawSeller: sellerItems.map((i) => ({ title: i.title, price: i.price, shipping: i.shipping, condition: i.condition, tokens: i.tokens })),
            rawJp: jpItems.map((i) => ({ title: i.title, price: i.price, shipping: i.shipping, condition: i.condition, tokens: i.tokens, seller: i.seller })),
          }
        : {}),
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
