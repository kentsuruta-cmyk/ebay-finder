const fetch = require('node-fetch');
const cheerio = require('cheerio');

const MODELS = [
  { name: 'ゲームボーイカラー', query: 'ゲームボーイカラー 本体', excludeWords: [] },
  { name: 'ゲームボーイポケット', query: 'ゲームボーイポケット 本体', excludeWords: [] },
  { name: 'ゲームボーイアドバンス', query: 'ゲームボーイアドバンス 本体', excludeWords: ['SP'] },
  { name: 'ゲームボーイアドバンスSP', query: 'ゲームボーイアドバンスSP 本体', excludeWords: [] },
  { name: 'DS', query: 'ニンテンドーDS 本体', excludeWords: ['Lite', 'DSi', 'LL'] },
  { name: 'DS Lite', query: 'DS Lite 本体', excludeWords: [] },
  { name: 'DSi', query: 'DSi 本体', excludeWords: ['LL'] },
  { name: 'DSi LL', query: 'DSi LL 本体', excludeWords: [] },
  { name: '3DS', query: '3DS 本体', excludeWords: ['LL'] },
  { name: '3DS LL', query: '3DS LL 本体', excludeWords: [] },
  { name: 'PSP 1000', query: 'PSP-1000 本体', excludeWords: [] },
  { name: 'PSP 2000', query: 'PSP-2000 本体', excludeWords: [] },
  { name: 'PSP 3000', query: 'PSP-3000 本体', excludeWords: [] },
];

const JUNK_WORDS = ['ジャンク', '動作未確認', '不動品', '動作不良'];

const SEARCH_TYPES = [
  { status: 'ジャンク', istatus: '3,4,5' },
  { status: '中古', istatus: '2,3' },
];

async function searchYahooAuction(query, istatus) {
  const url = `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(query)}&istatus=${istatus}&order=time&f=0x2&ei=UTF-8&tab_ex=commerce`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.9',
    }
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const items = [];

  $('li.Product').each((_, el) => {
    const title = $(el).find('.Product__title').text().trim();
    const link = $(el).find('a.Product__titleLink').attr('href') || '';
    const priceRaw = $(el).find('.Product__priceValue').first().text().trim();
    const price = priceRaw.replace(/[^0-9]/g, '');
    const endTimeText = $(el).find('.Product__time').text().trim();
    const postageText = $(el).find('.Product__postage').text().trim();
    const isStore = $(el).find('.Product__seller--store').length > 0
      || $(el).find('.Product__label--tax').length > 0
      || postageText.includes('税込');

    if (!title || !link) return;

    items.push({
      title,
      link,
      price: price || '不明',
      endTime: endTimeText,
      postage: postageText || '送料不明',
      isStore,
    });
  });

  return items;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const results = [];
    const seen = new Set();

    for (const model of MODELS) {
      for (const searchType of SEARCH_TYPES) {
        try {
          const items = await searchYahooAuction(model.query, searchType.istatus);
          for (const item of items) {
            if (seen.has(item.link)) continue;

            const excluded = model.excludeWords.some(w =>
              item.title.toLowerCase().includes(w.toLowerCase())
            );
            if (excluded) continue;

            seen.add(item.link);
            results.push({
              model: model.name,
              title: item.title,
              link: item.link,
              price: item.price,
              endTime: item.endTime,
              status: JUNK_WORDS.some(w => item.title.includes(w)) ? 'ジャンク' : searchType.status,
              postage: item.postage,
              isStore: item.isStore,
            });
          }
        } catch (e) {
          console.error(`Error for ${model.query} / istatus=${searchType.istatus}:`, e.message);
        }
      }
    }

    return res.status(200).json({ items: results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
