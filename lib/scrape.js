// 候補サイトの本文を実際に取得して連絡先を抜き出す。
// 旧実装は Google のスニペット3行だけを見て email / Instagram / WhatsApp を「出させて」いた。
// スニペットに書いていないものは出るはずがないので、ここは推測ではなく実測に置き換える。
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 1_500_000;
const CONTACT_PATHS = ['/contact', '/contact-us', '/pages/contact', '/pages/contact-us', '/contacts', '/kontakt', '/impressum', '/about'];
const MAX_SUB_FETCHES = 3;   // トップ以外に開くページの上限（Vercelの60秒に収めるため）

// 「日本からの輸入品をすでに扱っているか」の手がかり。日本限定の新品を売り込みやすい相手かどうかの目安。
const JAPAN_RE = /(japan(?:ese)?\s+(?:import|imports|version|exclusive|edition|console|model)s?|import(?:ed|s)?\s+from\s+japan|jp\s+import|ntsc[-\s]?j\b|直輸入|日本版)/gi;
// 問い合わせページへのリンク文言
const CONTACT_TEXT_RE = /^(contact|contact us|kontakt|contacto|contactez|nous contacter|get in touch|enquiries|inquiries)$/i;
const CONTACT_HREF_RE = /\/(pages\/)?(contact|contact-us|kontakt|contacto|contactez-nous|nous-contacter)(\/|\.html?|$|\?)/i;

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
  let contactPage = '';
  $('a[href]').each((_, el) => {
    const h = ($(el).attr('href') || '').trim();
    if (!h) return;
    hrefs.push(h);
    if (!contactPage) {
      const label = $(el).text().replace(/\s+/g, ' ').trim();
      if (CONTACT_TEXT_RE.test(label) || CONTACT_HREF_RE.test(h)) {
        try {
          const u = new URL(h, baseUrl);
          if (/^https?:$/.test(u.protocol)) contactPage = u.href;
        } catch {}
      }
    }
  });

  // 文章を書き込める問い合わせフォームがこのページにあるか（textarea か message 欄を持つ form）
  let contactForm = '';
  $('form').each((_, f) => {
    if (contactForm) return;
    const $f = $(f);
    const hasMessage = $f.find('textarea').length > 0 || $f.find('[name*="message" i], [name*="body" i]').length > 0;
    const isSearch = /search/i.test(($f.attr('action') || '') + ($f.attr('role') || '') + ($f.attr('class') || ''));
    if (hasMessage && !isSearch) contactForm = baseUrl;
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

  const japanSignals = [...new Set((text.match(JAPAN_RE) || []).map(m => m.toLowerCase()))].slice(0, 4);

  return {
    // <title> に改行が入っているサイトがあるので空白を潰す（表の見出しが崩れる）
    title: ($('title').first().text() || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    emails,
    email: emails[0] || '',
    instagram: firstMatch(abs, /instagram\.com\/[^/?#]+/i),
    facebook: firstMatch(abs, /facebook\.com\/[^/?#]+/i),
    twitter: firstMatch(abs, /(twitter\.com|x\.com)\/[^/?#]+/i),
    whatsapp,
    contactPage,
    contactForm,
    japanSignals,
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
    contactPage: a.contactPage || b.contactPage,
    contactForm: a.contactForm || b.contactForm,
    japanSignals: [...new Set([...(a.japanSignals || []), ...(b.japanSignals || [])])].slice(0, 4),
    excerpt: (a.excerpt || '').length >= (b.excerpt || '').length ? a.excerpt : b.excerpt,
  };
}

// トップページを見て、メールか問い合わせフォームが無ければ問い合わせページを追う。
// まずトップにあった「Contact」リンク、次に定番のパスを試す（最大 MAX_SUB_FETCHES 本）。
async function scrapeSite(url, { followContact = true } = {}) {
  const html = await fetchHtml(url);
  if (!html) return { url, fetched: false };

  let info = extractFromHtml(html, url);

  if (followContact && !(info.email && info.contactForm)) {
    let origin;
    try { origin = new URL(url).origin; } catch { origin = null; }
    if (origin) {
      const tried = new Set([url.replace(/\/$/, '')]);
      const queue = [info.contactPage, ...CONTACT_PATHS.map(p => origin + p)].filter(Boolean);
      let subs = 0;
      for (const next of queue) {
        const key = next.replace(/\/$/, '');
        if (tried.has(key)) continue;
        tried.add(key);
        if (subs >= MAX_SUB_FETCHES) break;
        subs++;
        const sub = await fetchHtml(next, 5000);
        if (!sub) continue;
        const subInfo = extractFromHtml(sub, next);
        // 問い合わせページとして開けたなら、そのURLを窓口として覚えておく
        if (!info.contactPage && CONTACT_HREF_RE.test(new URL(next).pathname)) subInfo.contactPage = next;
        info = merge(info, subInfo);
        if (info.email && info.contactForm) break;
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
