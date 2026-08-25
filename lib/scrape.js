// 候補サイトの本文を実際に取得して連絡先を抜き出す。
// 旧実装は Google のスニペット3行だけを見て email / Instagram / WhatsApp を「出させて」いた。
// スニペットに書いていないものは出るはずがないので、ここは推測ではなく実測に置き換える。
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 1_500_000;
const CONTACT_PATHS = ['/contact', '/contact-us', '/contacts', '/about', '/impressum', '/kontakt'];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// 画像ファイル名やsentryのDSNなどを拾わないための除外
const EMAIL_JUNK = /(\.(png|jpe?g|gif|svg|webp|css|js)$|sentry|wixpress|example\.com|@2x|domain\.com|yourdomain)/i;

async function fetchHtml(url, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) return null;
    const buf = await res.arrayBuffer();
    return Buffer.from(buf.slice(0, MAX_BYTES)).toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstMatch(list, re) {
  for (const v of list) if (re.test(v)) return v;
  return '';
}

// HTML から連絡先を抽出する。ここで返る値はすべてページ上に実在したもの。
function extractFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const hrefs = [];
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href');
    if (h) hrefs.push(h.trim());
  });

  const mailtos = hrefs
    .filter(h => h.toLowerCase().startsWith('mailto:'))
    .map(h => h.slice(7).split('?')[0].trim());

  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const bodyEmails = (text.match(EMAIL_RE) || []);

  const emails = [...new Set([...mailtos, ...bodyEmails])]
    .filter(e => e.includes('@') && !EMAIL_JUNK.test(e))
    .slice(0, 5);

  const abs = hrefs.map(h => {
    try { return new URL(h, baseUrl).href; } catch { return ''; }
  }).filter(Boolean);

  const waHref = firstMatch(abs, /(wa\.me|api\.whatsapp\.com|whatsapp:\/\/)/i);
  let whatsapp = '';
  if (waHref) {
    const m = waHref.match(/(?:wa\.me\/|phone=)(\+?\d{6,15})/);
    whatsapp = m ? m[1] : waHref;
  }

  return {
    title: ($('title').first().text() || '').trim().slice(0, 200),
    emails,
    email: emails[0] || '',
    instagram: firstMatch(abs, /instagram\.com\/[^/?#]+/i),
    facebook: firstMatch(abs, /facebook\.com\/[^/?#]+/i),
    twitter: firstMatch(abs, /(twitter\.com|x\.com)\/[^/?#]+/i),
    whatsapp,
    excerpt: text.slice(0, 2500),
  };
}

function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    title: a.title || b.title,
    emails: [...new Set([...(a.emails || []), ...(b.emails || [])])].slice(0, 5),
    email: a.email || b.email,
    instagram: a.instagram || b.instagram,
    facebook: a.facebook || b.facebook,
    twitter: a.twitter || b.twitter,
    whatsapp: a.whatsapp || b.whatsapp,
    excerpt: (a.excerpt || '').length >= (b.excerpt || '').length ? a.excerpt : b.excerpt,
  };
}

// トップページを見て、連絡先が埋まらなければ /contact 系も1本だけ追う
async function scrapeSite(url, { followContact = true } = {}) {
  const html = await fetchHtml(url);
  if (!html) return { url, fetched: false };

  let info = extractFromHtml(html, url);

  if (followContact && !info.email && !info.whatsapp) {
    let origin;
    try { origin = new URL(url).origin; } catch { origin = null; }
    if (origin) {
      for (const p of CONTACT_PATHS) {
        const sub = await fetchHtml(origin + p, 5000);
        if (!sub) continue;
        info = merge(info, extractFromHtml(sub, origin + p));
        if (info.email || info.whatsapp) break;
      }
    }
  }

  return { url, fetched: true, ...info };
}

// 同時実行数を絞って並列に回す（Vercelの実行時間内に収めるため）
async function scrapeMany(urls, { concurrency = 8, followContact = true } = {}) {
  const out = new Array(urls.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= urls.length) return;
      out[idx] = await scrapeSite(urls[idx], { followContact }).catch(() => ({ url: urls[idx], fetched: false }));
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { scrapeSite, scrapeMany, extractFromHtml, fetchHtml };
