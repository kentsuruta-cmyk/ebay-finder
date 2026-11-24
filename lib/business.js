// 「何を卸したいか」の前提。
//  - businessContext: Shop Finder の各段（切り口の提案・選別・評価・総括）で共通に使う説明文
//  - PITCHES: 営業文で「何を売り込むか」。画面の「売り込む商品」で切り替える
//
// もともとは携帯ゲーム機の卸しか想定しておらず、その前提が各APIに直書きされていた。
const DEFAULT_BUSINESS = '日本の中古・ジャンク携帯ゲーム機（Game Boy / GBC / GBA / GBA SP / DS / 3DS / PSP など）';

// business: 画面の「卸したい商品」欄の文章（空なら携帯ゲーム機）
function businessContext(business) {
  const what = String(business || '').trim().slice(0, 600) || DEFAULT_BUSINESS;
  return `私たちは日本から海外へ商品を卸している業者です。卸したい商品: ${what}
海外の「まとまった数を仕入れてくれる」小売店・専門店・リペア店・卸業者を探しています。
実店舗を持ち、オンラインでも販売している専門店は特に有望です。
情報サイト、ブログ、まとめ記事、マーケットプレイスの出品ページは対象外です。`;
}

// 営業文に渡す「こちらの事実」。ここに書いていないことはAIに書かせない（実績や数字を盛らせない）。
const PITCHES = {
  retro: {
    label: 'レトロ小型ゲーム機（中古）',
    facts: `- We are Kenja Games, a small trading company in Tokyo run by Ken.
- We sell used Japanese handheld consoles, tested and working: Game Boy Color, Game Boy Advance, GBA SP, Game Boy Pocket, DS Lite, DSi, 3DS, PSP 1000/2000/3000, and the XL/LL versions.
- We can also supply GBA and GBA SP units for parts (not working).
- We sell by the lot to shops. We buy in Japan every day, so stock changes weekly.
- We already sell to retro game shops in the US, the UK and the Middle East.
- We ship from Tokyo.`,
    offer: "this week's stock list with prices",
  },
  new_jp: {
    label: '日本限定の新品（Switch・アクセサリー）',
    facts: `- We are Kenja Games, a small trading company in Tokyo run by Ken.
- We supply brand-new, sealed products that are only sold in Japan: Nintendo Switch / Switch 2 accessories, Japan-only controllers and editions, Japanese-package games, and items that come with Japanese store-exclusive bonuses.
- We buy directly in Japan, including pre-orders, and ship from Tokyo.
- We can do small quantities to start.
- We have been selling Japanese game products to shops overseas for years (mostly retro handhelds so far).`,
    offer: 'a list of the Japan-only items we can get right now, with prices',
  },
};

// 署名。メール・問い合わせフォーム用
const SIGNATURE = `Ken
Kenja Games / Tokyo, Japan
kenja.co | IG: kenjagames2
ken_tsuruta@kenja.co`;

function getPitch(key) {
  return PITCHES[key] || PITCHES.retro;
}

module.exports = { businessContext, DEFAULT_BUSINESS, PITCHES, getPitch, SIGNATURE };
