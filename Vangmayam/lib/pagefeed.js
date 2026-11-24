// Turns a blog or news listing page into feed-like items, for sites that publish no RSS.
// It needs DOMParser, so it runs in the offscreen page and the app pages, never in the
// service worker. It reads the page the way a person would: look for links that lead to
// articles, then read the title, date, summary and picture from the card around each link.

const NOT_ARTICLE_PATH = /\/(tag|tags|topic|topics|category|categories|author|authors|page|search|about|contact|privacy|terms|careers|jobs|login|signin|signup|register|subscribe|newsletter|pricing|cookie|cookies|feed|rss|events|members|staff|brand|podcast|podcasts|video|videos|projects|landscape|board|tc|awards)(\/|$)/i;
const FILE_EXT = /\.(pdf|png|jpe?g|gif|webp|svg|zip|mp4|mp3|xml|json|css|js|ico)$/i;
const NOISE = 'script, style, noscript, template, svg, nav, footer, [role="navigation"], [role="contentinfo"], [aria-hidden="true"]';
const HEADINGS = 'h1, h2, h3, h4, h5, h6';

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_RES = [
  new RegExp(`\\b${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`, 'i'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTH}\\.?,? \\d{4}\\b`, 'i'),
  /\b\d{4}-\d{2}-\d{2}\b/,
];

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** Text of an element with a space between pieces, so adjacent spans do not run together. */
function flatText(el) {
  if (!el) return '';
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return clean(parts.join(' '));
}

function parseLooseDate(text) {
  for (const re of DATE_RES) {
    const m = (text || '').match(re);
    if (!m) continue;
    const t = Date.parse(m[0].replace(/(\d)(st|nd|rd|th)\b/i, '$1'));
    if (!Number.isNaN(t) && t > Date.UTC(2000, 0, 1) && t < Date.now() + 864e5) return t;
  }
  return 0;
}

function dateFromPath(path) {
  const m = path.match(/\/(20\d{2})\/(\d{1,2})(?:\/(\d{1,2}))?(?:\/|$)/);
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1));
  return Number.isNaN(t) || t > Date.now() + 864e5 ? 0 : t;
}

function normalize(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  return u;
}
const keyOf = (u) => `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;

export function extractPageItems(html, pageUrl, { max = 60 } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = normalize(pageUrl, pageUrl);
  const host = base.hostname.replace(/^www\./, '');
  const basePath = base.pathname.replace(/\/+$/, '');
  const selfKey = keyOf(base);
  const ogType = doc.querySelector('meta[property="og:type"]')?.getAttribute('content') || '';
  const title = clean(doc.title) || clean(doc.querySelector('meta[property="og:title"]')?.getAttribute('content')) || host;

  doc.querySelectorAll(NOISE).forEach((n) => n.remove());

  // 1. Which links look like they lead to articles?
  const groups = new Map(); // key -> { url, anchors, score }
  for (const a of doc.querySelectorAll('a[href]')) {
    const url = normalize(a.getAttribute('href'), base);
    if (!url || url.hostname.replace(/^www\./, '') !== host) continue;
    const key = keyOf(url);
    if (key === selfKey) continue;
    const path = url.pathname.replace(/\/+$/, '');
    const segs = path.split('/').filter(Boolean);
    if (!segs.length || path === basePath) continue;
    if (FILE_EXT.test(path) || NOT_ARTICLE_PATH.test(path)) continue;

    let score = 0;
    if (basePath && path.startsWith(`${basePath}/`)) score += 4; // sits under the listing, like /blog/some-post
    else if (basePath) score -= 1;
    const last = segs[segs.length - 1];
    if ((last.match(/-/g) || []).length >= 2) score += 2; // reads like a slug
    if (/\/20\d{2}\//.test(path)) score += 1;
    if (a.closest(HEADINGS) || a.querySelector(HEADINGS)) score += 2;
    if (a.closest('article, li')) score += 1;
    if (clean(a.textContent).length >= 15) score += 1;

    const g = groups.get(key) || { url, anchors: [], score: -99 };
    g.anchors.push(a);
    g.score = Math.max(g.score, score);
    groups.set(key, g);
  }
  const accepted = new Map([...groups].filter(([, g]) => g.score >= 4));
  const acceptedKey = (a) => { const u = normalize(a.getAttribute('href'), base); return u && accepted.has(keyOf(u)) ? keyOf(u) : null; };

  // 2. Read the card around each article link.
  const items = [];
  for (const [key, g] of accepted) {
    const first = g.anchors[0];
    let card = first;
    for (let i = 0; i < 8; i++) {
      const p = card.parentElement;
      if (!p || p === doc.body || p === doc.documentElement) break;
      const keys = new Set();
      p.querySelectorAll('a[href]').forEach((x) => { const k = acceptedKey(x); if (k) keys.add(k); });
      if (keys.size > 1) break;
      card = p;
    }

    const heads = [...card.querySelectorAll(HEADINGS)].map((h) => ({ h, t: clean(h.textContent) })).filter((x) => x.t);
    const own = heads.find((x) => g.anchors.some((a) => x.h.contains(a) || a.contains(x.h)));
    const longEnough = heads.find((x) => x.t.length >= 12);
    let text = own?.t || longEnough?.t || '';
    if (!text) {
      const anchorText = g.anchors.map((a) => flatText(a)).sort((x, y) => y.length - x.length)[0] || '';
      text = anchorText.length <= 200 ? anchorText : '';
    }
    if (!text) text = clean(first.getAttribute('aria-label') || first.getAttribute('title') || card.querySelector('img[alt]')?.getAttribute('alt'));
    text = text.replace(/\s*(read more|continue reading|learn more)\s*[→>»]*$/i, '').trim();
    if (text.length < 8 || text.length > 220) continue;

    const timeEl = card.querySelector('time');
    let published = 0;
    if (timeEl) published = Date.parse(timeEl.getAttribute('datetime') || '') || parseLooseDate(flatText(timeEl));
    if (!published) published = parseLooseDate(flatText(card));
    if (!published) published = dateFromPath(g.url.pathname);

    let summary = '';
    for (const p of card.querySelectorAll('p')) {
      const t = clean(p.textContent);
      if (t.length >= 40 && t !== text) { summary = t.slice(0, 320); break; }
    }
    if (!summary) {
      const d = card.querySelector('[class*="desc"], [class*="excerpt"], [class*="summary"], [class*="teaser"]');
      const t = clean(d?.textContent);
      if (t.length >= 30 && t !== text) summary = t.slice(0, 320);
    }

    let image = '';
    for (const img of card.querySelectorAll('img')) {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || (img.getAttribute('srcset') || '').split(/\s+/)[0];
      const meta = `${src} ${img.getAttribute('class') || ''} ${img.getAttribute('alt') || ''}`;
      if (!src || /avatar|logo|icon|sprite|author|profile/i.test(meta)) continue;
      const w = Number(img.getAttribute('width'));
      if (w && w <= 80) continue;
      const u = normalize(src, base);
      if (u) { image = u.href; break; }
    }

    const author = clean(card.querySelector('a[href*="/author/"], [rel="author"], [class*="author"]')?.textContent).slice(0, 80);

    items.push({
      guid: g.url.href, title: text, link: g.url.href, published, summary, html: '', image,
      author: author.length > 60 ? '' : author, media: null, _order: items.length,
    });
  }

  // A site's front page is full of marketing links. Only treat it as a post list when the posts are dated.
  if (!basePath) items.splice(0, items.length, ...items.filter((i) => i.published));

  // 3. When most cards carry a date, newest first. Otherwise keep the page order.
  const dated = items.filter((i) => i.published);
  if (dated.length >= items.length * 0.6) {
    items.sort((a, b) => (b.published - a.published) || (a._order - b._order));
  }
  items.forEach((i) => { delete i._order; });

  return {
    title,
    siteUrl: base.href,
    items: items.slice(0, max),
    looksLikeArticle: /^article$/i.test(ogType),
  };
}
