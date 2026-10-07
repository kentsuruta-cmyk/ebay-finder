// 「何を卸したいか」の前提。Shop Finder の各段（切り口の提案・選別・評価・総括）で共通に使う。
//
// もともとは携帯ゲーム機の卸しか想定しておらず、その前提が各APIに直書きされていた。
// 万年筆など他の商品でも卸先を探せるよう、画面から渡された説明があればそちらを使う。
const DEFAULT_BUSINESS = '日本の中古・ジャンク携帯ゲーム機（Game Boy / GBC / GBA / GBA SP / DS / 3DS / PSP など）';

// business: 画面の「卸したい商品」欄の文章（空なら携帯ゲーム機）
function businessContext(business) {
  const what = String(business || '').trim().slice(0, 600) || DEFAULT_BUSINESS;
  return `私たちは日本から海外へ商品を卸している業者です。卸したい商品: ${what}
海外の「まとまった数を仕入れてくれる」小売店・専門店・リペア店・卸業者を探しています。
実店舗を持ち、オンラインでも販売している専門店は特に有望です。
情報サイト、ブログ、まとめ記事、マーケットプレイスの出品ページは対象外です。`;
}

module.exports = { businessContext, DEFAULT_BUSINESS };
