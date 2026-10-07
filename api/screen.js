// 商品ふるい分け。
//
// 「どの商品なら、eBayの中に卸先（B2Bの買い手）がいるか」を、商品カテゴリ1つぶん調べる。
// 携帯ゲーム機で卸が成り立ったのは、同じ機種を日本のセラーより高く・数多く売っている
// 海外セラーがeBayの中にいたから。その構図があるかどうかを、出品データから数字で出す。
//
// 1回の呼び出し＝1キーワード。画面側が候補リストを順に投げる。
// ※販売実績（売れた件数）は Browse API では取れない。ここで見ているのは「いま出品されているもの」。
const { searchItems } = require('../lib/ebay');

const median = (arr) => {
  const v = arr.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// タイトルから型番らしい語を拾う（DMG-01 / DW-5600E / SD-1 / AGS 101 / Stella 2500S など）。
// 区切りを無視して1語にそろえる。3つの形を拾う:
//   ハイフン区切り … SD-1, WM-EX1, CGB-001（数字1桁でも型番とみなせる）
//   区切りなし     … PG1005, DW5600E（数字2桁以上）
//   空白区切り     … AGS 101, Stella 2500S（数字3桁以上。年号や「35mm」を誤って拾わないため厳しめ）
// 数字だけの型番は他の数字と区別できないので拾わない＝あくまで目安。
const MODEL_PATTERNS = [
  /\b([A-Z]{1,6})-([A-Z]{0,3}\d{1,5}[A-Z]{0,3})\b/g,
  /\b([A-Z]{1,6})(\d{2,5}[A-Z]{0,3})\b/g,
  /\b([A-Z]{2,8}) (\d{3,5}[A-Z]{0,2})\b(?!\s?MM)/g,
];
// 型番ではないのに形だけ一致する語（先頭の英字部分で判定）
const NOT_MODEL = new Set(('USB MP GB MB TB ISO NO LOT SET PCS PC EX VOL AC DC HD FM AM CD MD DVD JAPAN JP FROM FOR OF WITH AND IN USED NEW ' +
  'MINT NEAR TESTED PARTS SIZE CIRCA YEAR APP TOP MM CM MADE BOX MODEL TYPE VER VERSION SERIAL QTY ITEM OVER UNDER ABOUT ONLY PEDAL ' +
  'CAMERA LENS WATCH REEL FILM VINTAGE RARE EXC EXCELLENT GOOD WORKING').split(' '));

function modelTokens(title) {
  const out = new Set();
  const t = String(title || '').toUpperCase();
  for (const re of MODEL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      if (NOT_MODEL.has(m[1])) continue;
      if (/^(19[5-9]\d|20[0-4]\d)$/.test(m[2])) continue; // 年号
      out.add(`${m[1]}${m[2]}`);
    }
  }
  return [...out];
}

function slim(item) {
  const price = item.price && item.price.currency === 'USD' ? parseFloat(item.price.value) : null;
  return {
    id: item.itemId,
    title: item.title || '',
    price: Number.isNaN(price) ? null : price,
    country: item.itemLocation ? item.itemLocation.country : null,
    seller: item.seller ? item.seller.username : null,
    feedback: item.seller ? item.seller.feedbackScore || 0 : 0,
    tokens: modelTokens(item.title),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const {
    keyword,
    minPrice = '50',        // これ未満は付属品・部品とみなして母数から外す（USD）
    conditionIds = '3000',  // 既定は中古。1000=新品、空文字=すべて
    minFeedback = '300',    // 「卸先になり得るセラー」の最低評価数
    minHits = '3',          // 同上：この検索で何点以上出していれば継続的に扱っているとみなすか
  } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword は必須です' });

  const globalId = 'EBAY-US';
  const floor = Math.max(0, parseFloat(minPrice) || 0);
  const conds = String(conditionIds).split(',').filter(Boolean);
  const priceFilter = floor > 0 ? [`price:[${floor}..]`, 'priceCurrency:USD'] : [];

  try {
    // 全体（おすすめ順の先頭1000件）と、日本発送だけ（先頭400件）を別々に取る。
    // 全体だけだと日本発送の出品が埋もれて、日本セラーの価格が安定して出ないため。
    const [all, jp] = await Promise.all([
      searchItems({ globalId, keyword, maxItems: 1000, conditionIds: conds, extraFilters: priceFilter }),
      searchItems({ globalId, keyword, maxItems: 400, conditionIds: conds, extraFilters: [...priceFilter, 'itemLocationCountry:JP'] }),
    ]);

    const seen = new Set();
    const items = [];
    for (const raw of [...jp.items, ...all.items]) {
      if (seen.has(raw.itemId)) continue;
      seen.add(raw.itemId);
      const it = slim(raw);
      if (it.price == null || !it.seller) continue;
      items.push(it);
    }
    const jpItems = items.filter((i) => i.country === 'JP');
    const overseas = items.filter((i) => i.country && i.country !== 'JP');

    const jpMedian = median(jpItems.map((i) => i.price));
    const overseasMedian = median(overseas.map((i) => i.price));

    // ── 同じ型番どうしの価格差 ──
    // カテゴリ全体の中央値どうしを比べると、扱う機種の違い（海外は高級機が多い等）が混ざる。
    // 日本・海外の両方に3点以上ある型番だけを取り出し、型番ごとに 海外÷日本 を出して中央値を取る。
    const byToken = new Map();
    for (const it of items) {
      for (const tk of it.tokens) {
        if (!byToken.has(tk)) byToken.set(tk, { jp: [], os: [] });
        if (it.country === 'JP') byToken.get(tk).jp.push(it.price);
        else if (it.country) byToken.get(tk).os.push(it.price);
      }
    }
    const pairs = [];
    for (const [token, g] of byToken) {
      if (g.jp.length >= 3 && g.os.length >= 3) {
        const a = median(g.jp), b = median(g.os);
        pairs.push({ token, jpMedian: round(a), overseasMedian: round(b), ratio: round(b / a), jpCount: g.jp.length, overseasCount: g.os.length });
      }
    }
    pairs.sort((x, y) => (y.jpCount + y.overseasCount) - (x.jpCount + x.overseasCount));
    const sameModelRatio = pairs.length >= 3 ? round(median(pairs.map((p) => p.ratio))) : null;

    // ── 型番の集中度（商品管理の軽さの目安） ──
    // 型番が拾えた出品のうち、上位15型番で何%を占めるか。高いほど少ない型番で回せる。
    const tokenCount = new Map();
    let withToken = 0;
    for (const it of items) {
      if (!it.tokens.length) continue;
      withToken++;
      for (const tk of it.tokens) tokenCount.set(tk, (tokenCount.get(tk) || 0) + 1);
    }
    const tokenRank = [...tokenCount.entries()].sort((a, b) => b[1] - a[1]);
    const top15 = new Set(tokenRank.slice(0, 15).map((x) => x[0]));
    const coveredByTop15 = items.filter((it) => it.tokens.some((tk) => top15.has(tk))).length;

    // ── 卸先になり得る海外セラー ──
    // 日本以外から、この商品を継続的に（minHits点以上）、ある程度の規模（評価数）で売っているセラー。
    // そのセラーの売値の中央値が日本セラーの中央値の何倍かを出す。
    const minFb = parseInt(minFeedback, 10) || 0;
    const needHits = Math.max(1, parseInt(minHits, 10) || 3);
    const sellerMap = new Map();
    for (const it of overseas) {
      if (!sellerMap.has(it.seller)) sellerMap.set(it.seller, { username: it.seller, country: it.country, feedback: it.feedback, prices: [], titles: [] });
      const s = sellerMap.get(it.seller);
      s.prices.push(it.price);
      if (s.titles.length < 3) s.titles.push(it.title.slice(0, 80));
    }
    const sellers = [...sellerMap.values()]
      .filter((s) => s.prices.length >= needHits && s.feedback >= minFb)
      .map((s) => ({
        username: s.username,
        country: s.country,
        feedback: s.feedback,
        hits: s.prices.length,
        medianPrice: round(median(s.prices)),
        ratio: jpMedian ? round(median(s.prices) / jpMedian) : null,
        titles: s.titles,
      }))
      .sort((a, b) => b.hits - a.hits);

    return res.status(200).json({
      keyword,
      minPrice: floor,
      totalListings: all.total,          // eBay側の総ヒット数（条件に合う出品の実数）
      jpListings: jp.total,              // うち日本発送
      jpShare: all.total ? round(jp.total / all.total, 3) : null,
      scanned: items.length,
      scannedJp: jpItems.length,
      scannedOverseas: overseas.length,
      jpMedian: round(jpMedian),
      overseasMedian: round(overseasMedian),
      overallRatio: jpMedian && overseasMedian ? round(overseasMedian / jpMedian) : null,
      sameModelRatio,
      sameModelPairs: pairs.slice(0, 12),
      modelCount: tokenRank.length,
      modelCoverage: items.length ? round(withToken / items.length, 3) : null, // 型番が拾えた出品の割合
      top15Share: withToken ? round(coveredByTop15 / withToken, 3) : null,
      topModels: tokenRank.slice(0, 15).map(([token, count]) => ({ token, count })),
      sellers: sellers.slice(0, 40),
      sellerCount: sellers.length,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message, keyword });
  }
};
