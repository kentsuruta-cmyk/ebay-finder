// マージ後の上位セラーについて「本当の出品数」を取りに行く。
// 旧UIの ITEMS 列は取得した100件のうち何件かを数えていただけで、店の規模を表していなかった。
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

  const { sellers = [], keyword = '', categoryIds = '', conditionIds = '' } = req.body || {};
  if (!sellers.length) return res.status(400).json({ error: 'sellers が空です' });

  const conds = conditionIds ? String(conditionIds).split(',').filter(Boolean) : undefined;

  try {
    const results = await mapLimit(sellers.slice(0, 60), 10, async s => {
      // カテゴリ全体での出品数（店の在庫規模）と、キーワード一致数の両方を取る
      const [categoryCount, keywordCount] = await Promise.all([
        categoryIds
          ? countSellerItems({ globalId: s.market, username: s.username, categoryIds, conditionIds: conds })
          : Promise.resolve(null),
        keyword
          ? countSellerItems({ globalId: s.market, keyword, username: s.username, categoryIds: categoryIds || undefined, conditionIds: conds })
          : Promise.resolve(null),
      ]);
      return { username: s.username, categoryCount, keywordCount };
    });

    return res.status(200).json({ stats: results.filter(Boolean) });
  } catch (err) {
    return res.status(502).json({ error: err.message, stats: [] });
  }
};
