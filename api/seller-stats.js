// マージ後の上位セラーについて「本当の出品数」を取りに行く。
// 旧UIの ITEMS 列は取得した100件のうち何件かを数えていただけで、店の規模を表していなかった。
//
// 注意: category_ids だけ（q なし）+ sellers フィルタの件数は eBay 側が
// 信用できない値を返す（実際に4万点規模のセラーが 56 や 0 になる）ため使わない。
// q ありのキーワード一致件数は正しい値が返るので、そちらを採用する。
const { countSellerItems } = require('../lib/ebay');

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= list.length) return;
        out[idx] = await fn(list[idx]).catch(() => null);
      }
    })
  );
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sellers = [], keywords = [], categoryIds = '', conditionIds = '' } = req.body || {};
  if (!sellers.length) return res.status(400).json({ error: 'sellers が空です' });
  if (!keywords.length) return res.status(400).json({ error: 'keywords が空です' });

  const conds = conditionIds ? String(conditionIds).split(',').filter(Boolean) : undefined;
  const kws = keywords.slice(0, 3);

  try {
    const results = await mapLimit(sellers.slice(0, 60), 8, async s => {
      const counts = await Promise.all(
        kws.map(kw =>
          countSellerItems({
            globalId: s.market,
            keyword: kw,
            username: s.username,
            categoryIds: categoryIds || undefined,
            conditionIds: conds,
          })
        )
      );
      const byKeyword = {};
      kws.forEach((kw, i) => { if (counts[i] != null) byKeyword[kw] = counts[i]; });
      const valid = counts.filter(c => c != null);
      // 複数キーワードにまたがる出品を二重に数えないよう、合計ではなく最大値を採る
      return {
        username: s.username,
        listingCount: valid.length ? Math.max(...valid) : null,
        byKeyword,
      };
    });

    return res.status(200).json({ stats: results.filter(Boolean) });
  } catch (err) {
    return res.status(502).json({ error: err.message, stats: [] });
  }
};
