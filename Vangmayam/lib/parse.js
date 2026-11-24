// DOM-based RSS 2.0, RSS 1.0 and Atom parser. Needs DOMParser, so it runs in
// the offscreen document and the side panel, never in the service worker.

const child = (el, name) => {
  for (const c of el.children) if (c.localName === name) return c;
  return null;
};
const childText = (el, name) => child(el, name)?.textContent?.trim() || '';
const byTag = (el, qname) => el.getElementsByTagName(qname)[0] || null;

const abs = (u, base) => {
  if (!u) return '';
  try { return new URL(u, base).href; } catch { return u; }
};

function snippet(html) {
  if (!html) return '';
  const d = new DOMParser().parseFromString(html, 'text/html');
  return (d.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 320);
}

function firstImage(html, base) {
  if (!html) return '';
  const d = new DOMParser().parseFromString(html, 'text/html');
  const src = d.querySelector('img')?.getAttribute('src');
  return src ? abs(src, base) : '';
}

function rssLink(item, base) {
  for (const c of item.children) {
    if (c.localName !== 'link') continue;
    const t = c.textContent.trim();
    if (t) return abs(t, base);
    const h = c.getAttribute('href');
    if (h && (!c.getAttribute('rel') || c.getAttribute('rel') === 'alternate')) return abs(h, base);
  }
  return '';
}

function parseDate(s) {
  const t = Date.parse(s || '');
  return Number.isNaN(t) ? 0 : t;
}

function parseRss(doc, feedUrl) {
  const ch = doc.querySelector('channel') || doc.documentElement;
  const title = childText(ch, 'title');
  const siteUrl = abs(childText(ch, 'link'), feedUrl);
  const items = [...doc.querySelectorAll('item')].map((it) => {
    const html = byTag(it, 'content:encoded')?.textContent || childText(it, 'description');
    const link = rssLink(it, feedUrl);
    const enc = child(it, 'enclosure');
    const encType = enc?.getAttribute('type') || '';
    const media = enc && /^(audio|video)\//.test(encType) ? { url: abs(enc.getAttribute('url'), feedUrl), type: encType } : null;
    const image =
      (enc && encType.startsWith('image/') && abs(enc.getAttribute('url'), feedUrl)) ||
      abs(byTag(it, 'media:thumbnail')?.getAttribute('url'), feedUrl) ||
      abs(byTag(it, 'media:content')?.getAttribute('url'), feedUrl) ||
      abs(byTag(it, 'itunes:image')?.getAttribute('href'), feedUrl) ||
      firstImage(html, link || feedUrl);
    return {
      guid: childText(it, 'guid') || link,
      title: childText(it, 'title'),
      link,
      published: parseDate(childText(it, 'pubDate') || byTag(it, 'dc:date')?.textContent),
      html,
      summary: snippet(childText(it, 'description') || html),
      author: byTag(it, 'dc:creator')?.textContent?.trim() || childText(it, 'author'),
      image,
      media,
    };
  });
  return { title, siteUrl, items };
}

function parseAtom(doc, feedUrl) {
  const f = doc.documentElement;
  const title = childText(f, 'title');
  let siteUrl = '';
  for (const l of f.children) {
    if (l.localName === 'link' && (!l.getAttribute('rel') || l.getAttribute('rel') === 'alternate')) {
      siteUrl = abs(l.getAttribute('href'), feedUrl);
    }
  }
  const items = [...f.children]
    .filter((c) => c.localName === 'entry')
    .map((e) => {
      let link = '';
      for (const l of e.children) {
        if (l.localName === 'link' && (!l.getAttribute('rel') || l.getAttribute('rel') === 'alternate')) {
          link = abs(l.getAttribute('href'), feedUrl);
          break;
        }
      }
      const c = child(e, 'content');
      const sum = child(e, 'summary');
      const group = byTag(e, 'media:group');
      const mediaDesc = group ? byTag(group, 'media:description')?.textContent : '';
      let html = '';
      if (c) html = c.getAttribute('type') === 'xhtml' ? c.innerHTML : c.textContent;
      else if (sum) html = sum.textContent;
      else if (mediaDesc) html = `<p>${mediaDesc.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;
      const image =
        abs((group && byTag(group, 'media:thumbnail')?.getAttribute('url')) || byTag(e, 'media:thumbnail')?.getAttribute('url'), feedUrl) ||
        firstImage(html, link || feedUrl);
      const author = child(e, 'author');
      return {
        guid: childText(e, 'id') || link,
        title: childText(e, 'title'),
        link,
        published: parseDate(childText(e, 'published') || childText(e, 'updated')),
        html,
        summary: snippet(sum?.textContent || html || mediaDesc),
        author: author ? childText(author, 'name') : '',
        image,
        media: null,
      };
    });
  return { title, siteUrl, items };
}

export function parseFeed(xmlText, feedUrl = '') {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('That page is not a valid feed.');
  const name = doc.documentElement.localName.toLowerCase();
  if (name === 'feed') return parseAtom(doc, feedUrl);
  if (name === 'rss' || name === 'rdf') return parseRss(doc, feedUrl);
  throw new Error('That page is not an RSS or Atom feed.');
}

/** Feed addresses a web page advertises through <link rel="alternate">. Needs DOMParser. */
export function feedLinksFromHtml(html, base = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = new Set();
  doc.querySelectorAll('link[rel~="alternate"][type*="rss"], link[rel~="alternate"][type*="atom"], link[rel~="alternate"][type*="xml"]').forEach((l) => {
    const h = l.getAttribute('href');
    if (!h) return;
    try { out.add(new URL(h, base || undefined).href); } catch { /* skip bad href */ }
  });
  return [...out];
}
