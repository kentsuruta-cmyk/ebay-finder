// メルカリ内部APIの薄いクライアント（国内の相場を見るためだけに使う）。
// ヤフオク・メルカリ仕入れ監視ツール（yahooauction-watcher）で実測済みの方式をそのまま持ってきたもの。
// 内部APIは DPoP（RFC 9449）ヘッダーが必須。使い捨ての ES256 鍵ペアを毎回作って自己署名する。
const crypto = require('crypto');

const SEARCH_ENDPOINT = 'https://api.mercari.jp/v2/entities:search';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createDpopToken(url, method) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y } };
  const payload = { iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), htu: url, htm: method, uuid: crypto.randomUUID() };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  // ES256 は R||S の生署名（IEEE P1363）。DER のままだと 401 になる
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return signingInput + '.' + base64url(signature);
}

// status: 'STATUS_SOLD_OUT'（売り切れ＝実際に売れた値段）か 'STATUS_ON_SALE'
async function searchMercari({ keyword, status = 'STATUS_SOLD_OUT', priceMin = 0, priceMax = 0, conditions = [] }) {
  const body = {
    userId: '',
    pageSize: 120,
    pageToken: '',
    searchSessionId: crypto.randomUUID(),
    indexRouting: 'INDEX_ROUTING_UNSPECIFIED',
    thumbnailTypes: [],
    searchCondition: {
      keyword,
      excludeKeyword: '',
      sort: 'SORT_CREATED_TIME',
      order: 'ORDER_DESC',
      status: [status],
      sizeId: [], categoryId: [], brandId: [], sellerId: [],
      priceMin, priceMax,
      itemConditionId: conditions,
      shippingPayerId: [], shippingFromArea: [], shippingMethod: [], colorId: [],
      hasCoupon: false, attributes: [], itemTypes: [], skuIds: [], shopIds: [],
    },
    defaultDatasets: ['DATASET_TYPE_MERCARI', 'DATASET_TYPE_BEYOND'],
    serviceFrom: 'suruga',
    withItemBrand: false, withItemSize: false, withItemPromotions: false, withItemSizes: false,
    withShopname: false, useDynamicAttribute: true, withSuggestedItems: false,
    withOfferPricePromotion: false, withProductSuggest: false, withParentProducts: false,
    withProductArticles: false, withSearchConditionId: false, withAuction: false,
  };
  const res = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      DPoP: createDpopToken(SEARCH_ENDPOINT, 'POST'),
      'X-Platform': 'web',
      Accept: '*/*',
      'Accept-Language': 'ja,en;q=0.9',
      Origin: 'https://jp.mercari.com',
      Referer: 'https://jp.mercari.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`メルカリ検索エラー ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

module.exports = { searchMercari };
