// eBayセラーの「eBayの外の連絡先」を探す。
//
// eBay内のメッセージで直接取引に誘うとアカウントが止まるので使わない。
// 代わりに、セラー名と同じ名前のHP・Instagram・Facebook・Xを探し、
// HPが見つかればそのページから問い合わせフォーム・メールを実測する。
//
// 旧実装（api/message.js）は1件ごとにClaudeにWeb検索させていて、20〜40秒かかり費用も高かった。
// ここは Serper（Google検索）＋HTML取得だけで済ませ、AIは使わない。
const { scrapeSite } = require('./scrape');

// HPとして採用しないドメイン（マーケットプレイス・SNS・まとめ・評判サイトなど）
const NOT_A_SHOP = [
  'ebay.', 'amazon.', 'aliexpress.', 'etsy.com', 'walmart.com', 'mercari.', 'alibaba.com', 'temu.com',
  'reddit.com', 'youtube.com', 'facebook.com', 'instagram.com', 'pinterest.', 'quora.com',
  'x.com', 'twitter.com', 'tiktok.com', 'threads.net', 'linkedin.com', 'wikipedia.org', 'fandom.com',
  'trustpilot.com', 'sitejabber.com', 'yelp.com', 'bbb.org', 'scamadviser.com', 'feedbackpro',
  'zoominfo.com', 'opencorporates.com', 'companieshouse', 'dnb.com', 'bizapedia.com',
  'goofbid.com', 'ebaystores', 'picclick.', 'worthpoint.com', 'terapeak', 'zikanalytics',
];

// SNSのURLのうち、プロフィールではないもの
const IG_SKIP = /^(p|reel|reels|explore|stories|tv|accounts|about|developer)$/i;
const FB_SKIP = /^(groups|events|watch|marketplace|photo\.php|story\.php|permalink\.php|people|public|hashtag|share|sharer\.php|login)$/i;
const X_SKIP = /^(search|hashtag|i|intent|share|home|explore|login)$/i;

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// 名前がほぼ同じか（記号の違いは無視。短すぎる名前は誤爆しやすいので完全一致のみ）
function sameName(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 5 || y.length < 5) return false;
  return x.includes(y) || y.includes(x);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// shop.co.uk → shop / my-retro-store.com → myretrostore
function hostLabel(host) {
  const parts = host.split('.');
  // 末尾のTLD（co.uk のような2段も）を落として、いちばん長いラベルを採る
  const core = parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts.slice(0, -2) : parts.slice(0, -1);
  return core.sort((a, b) => b.length - a.length)[0] || host;
}

function isNotShop(url) {
  const h = hostOf(url);
  return !h || NOT_A_SHOP.some(b => h.includes(b));
}

function firstSegment(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean)[0] || ''); } catch { return ''; }
}

async function serper(q, key, num = 10) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num, hl: 'en' }),
  });
  if (!r.ok) throw new Error(`Serper HTTP ${r.status}`);
  const data = await r.json();
  return (data.organic || []).map(o => ({ title: o.title || '', url: o.link || '', snippet: o.snippet || '' }));
}

// SNS検索の結果から、セラー名と同じ名前のプロフィールを1つ選ぶ
function pickProfile(results, username, hostRe, skipRe, canonical) {
  for (const r of results) {
    if (!hostRe.test(hostOf(r.url))) continue;
    const seg = firstSegment(r.url);
    if (!seg || skipRe.test(seg)) continue;
    if (sameName(seg, username)) return canonical(seg);
  }
  return '';
}

// 一般検索の結果から、セラーのHPらしいものを1つ選ぶ
//  domain: ドメイン名がセラー名とほぼ同じ（いちばん確か）
//  title : ページタイトルにセラー名がそのまま入っている
function pickWebsite(results, username) {
  let byTitle = null;
  for (const r of results) {
    if (isNotShop(r.url)) continue;
    const host = hostOf(r.url);
    if (sameName(hostLabel(host), username)) return { url: `https://${host}`, match: 'domain' };
    if (!byTitle && norm(username).length >= 5 && norm(r.title).includes(norm(username))) {
      byTitle = { url: `https://${host}`, match: 'title' };
    }
  }
  return byTitle;
}

async function findSellerContacts({ username }, { serperKey }) {
  const out = {
    username,
    website: '', websiteMatch: '',      // domain | title
    siteFetched: false,
    contactForm: '', contactPage: '',
    email: '', emails: [],
    instagram: '', facebook: '', x: '', whatsapp: '',
    source: {},                          // 各SNSが「site（HPに載っていた）」か「name（名前一致）」か
    japanSignals: [],
    siteTitle: '', siteExcerpt: '',
    checkedAt: new Date().toISOString(),
  };

  const q = String(username).trim();
  const [web, ig, fb, x] = await Promise.all([
    serper(`"${q}"`, serperKey).catch(() => []),
    serper(`${q} site:instagram.com`, serperKey, 5).catch(() => []),
    serper(`${q} site:facebook.com`, serperKey, 5).catch(() => []),
    serper(`${q} (site:x.com OR site:twitter.com)`, serperKey, 5).catch(() => []),
  ]);

  // 名前一致で拾ったSNS（同名の別人の可能性があるので「要確認」扱い）
  const igName = pickProfile(ig, q, /instagram\.com$/, IG_SKIP, s => `https://www.instagram.com/${s}/`);
  const fbName = pickProfile(fb, q, /facebook\.com$/, FB_SKIP, s => `https://www.facebook.com/${s}`);
  const xName = pickProfile(x, q, /(^|\.)(x|twitter)\.com$/, X_SKIP, s => `https://x.com/${s}`);
  if (igName) { out.instagram = igName; out.source.instagram = 'name'; }
  if (fbName) { out.facebook = fbName; out.source.facebook = 'name'; }
  if (xName) { out.x = xName; out.source.x = 'name'; }

  // HP → 実際に開いて窓口を実測
  const site = pickWebsite(web, q);
  if (site) {
    out.website = site.url;
    out.websiteMatch = site.match;
    const s = await scrapeSite(site.url).catch(() => ({ fetched: false }));
    if (s.fetched) {
      out.siteFetched = true;
      out.contactForm = s.contactForm || '';
      out.contactPage = s.contactPage || '';
      out.email = s.email || '';
      out.emails = s.emails || [];
      out.whatsapp = s.whatsapp || '';
      out.japanSignals = s.japanSignals || [];
      out.siteTitle = s.title || '';
      out.siteExcerpt = (s.excerpt || '').slice(0, 800);
      // HPに載っていたSNSは名前一致より確か。上書きする
      if (s.instagram) { out.instagram = s.instagram; out.source.instagram = 'site'; }
      if (s.facebook) { out.facebook = s.facebook; out.source.facebook = 'site'; }
      if (s.twitter) { out.x = s.twitter; out.source.x = 'site'; }
    }
  }

  return out;
}

// 窓口の強さ。並び替えと「窓口あり」表示に使う
//  2: HPに問い合わせフォームかメールがある（ちゃんとした店で、すぐ送れる）
//  1: SNSだけ見つかった
//  0: 何もない
function contactLevel(c) {
  if (!c) return 0;
  if (c.siteFetched && (c.contactForm || c.email || c.contactPage)) return 2;
  if (c.instagram || c.facebook || c.x) return 1;
  return 0;
}

module.exports = { findSellerContacts, contactLevel, sameName, hostLabel };
