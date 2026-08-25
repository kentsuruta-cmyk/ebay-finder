// eBay Browse API クライアント。
// 旧実装は1リクエスト＝1ページ（最大200件）しか取らなかったため、
// 「検索結果の先頭200件に写り込んだセラー」しか見えていなかった。ここでページングする。
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

const PAGE_SIZE = 200;        // Browse API の1ページ上限。201以上は400になる
const MAX_OFFSET = 10000;     // offset + limit の上限

let tokenCache = { value: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET が設定されていません');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`eBayトークン取得に失敗: ${data.error_description || JSON.stringify(data).slice(0, 200)}`);
  }
  // expires_in は通常7200秒。5分の安全マージンを取る
  tokenCache = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenCache.value;
}

function marketplaceId(globalId) {
  return String(globalId || 'EBAY-US').replace('EBAY-', 'EBAY_');
}

function buildFilter({ conditionIds } = {}) {
  const parts = ['buyingOptions:{FIXED_PRICE}'];
  if (conditionIds && conditionIds.length) parts.push(`conditionIds:{${conditionIds.join('|')}}`);
  return parts.join(',');
}

// 1ページ取得。失敗は握りつぶさず投げる（旧実装は空配列を返して「0件」に見せていた）
async function fetchPage({ token, globalId, keyword, offset, limit, categoryIds, conditionIds }) {
  const params = new URLSearchParams({
    q: keyword,
    limit: String(limit),
    offset: String(offset),
    filter: buildFilter({ conditionIds }),
  });
  if (categoryIds) params.set('category_ids', categoryIds);

  const res = await fetch(`${SEARCH_URL}?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId(globalId),
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.errors?.[0]?.message || data?.error_description || `HTTP ${res.status}`;
    throw new Error(`eBay検索エラー: ${msg}`);
  }
  return { items: data.itemSummaries || [], total: data.total || 0 };
}

// keyword × marketplace を、必要ページ数だけ並列で取る
async function searchItems({ globalId, keyword, maxItems = 600, categoryIds, conditionIds }) {
  const token = await getToken();

  let usedCategoryIds = categoryIds;
  let first = await fetchPage({ token, globalId, keyword, offset: 0, limit: PAGE_SIZE, categoryIds, conditionIds })
    .catch(err => { if (categoryIds) return null; throw err; });

  // カテゴリIDはマーケットによって通らないことがある。
  // 空振りしたら黙って0件を返さず、カテゴリ無しでやり直す。
  if (categoryIds && (!first || first.items.length === 0)) {
    const retry = await fetchPage({ token, globalId, keyword, offset: 0, limit: PAGE_SIZE, conditionIds });
    if (retry.items.length > 0) { first = retry; usedCategoryIds = undefined; }
    else if (!first) first = retry;
  }

  const available = Math.min(first.total, MAX_OFFSET);
  const want = Math.min(maxItems, available);

  const offsets = [];
  for (let o = PAGE_SIZE; o < want; o += PAGE_SIZE) offsets.push(o);

  const rest = await Promise.all(
    offsets.map(o =>
      fetchPage({ token, globalId, keyword, offset: o, limit: PAGE_SIZE, categoryIds: usedCategoryIds, conditionIds })
        .then(p => p.items)
        .catch(() => [])   // 後続ページの失敗は部分結果で続行
    )
  );

  return {
    items: first.items.concat(...rest).slice(0, want),
    total: first.total,
    categoryFallback: !!categoryIds && !usedCategoryIds,
  };
}

// 特定セラーがそのキーワードで何点出しているか。
// 旧UIの ITEMS 列は「取得した100件のうち何件か」で、出品数ではなかった。これは本物の件数。
async function countSellerItems({ globalId, keyword, username, categoryIds, conditionIds }) {
  const token = await getToken();
  const params = new URLSearchParams({
    q: keyword,
    limit: '1',
    filter: `${buildFilter({ conditionIds })},sellers:{${username}}`,
  });
  if (categoryIds) params.set('category_ids', categoryIds);
  const res = await fetch(`${SEARCH_URL}?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId(globalId),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.total === 'number' ? data.total : null;
}

module.exports = { searchItems, countSellerItems, PAGE_SIZE };
