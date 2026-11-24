const DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea',
  'svg', 'math', 'noscript', 'link', 'meta', 'template', 'canvas', 'dialog', 'base',
]);

const KEEP = new Set([
  'a', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'sup', 'sub', 'span', 'div', 'details', 'summary', 'video', 'audio', 'source', 'picture', 'mark', 'del', 'ins',
  'small', 'dl', 'dt', 'dd', 'section', 'article',
]);

const ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  video: ['src', 'poster'],
  audio: ['src'],
  source: ['src', 'type'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start'],
};

function safeUrl(u, base, { image = false, mail = false } = {}) {
  if (!u) return null;
  let url;
  try { url = new URL(u, base || undefined); } catch { return null; }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  if (mail && url.protocol === 'mailto:') return url.href;
  if (image && /^data:image\/(png|jpe?g|gif|webp);/i.test(u)) return u;
  return null;
}

function clean(node, base) {
  for (const el of [...node.children]) {
    const tag = el.localName;
    if (DROP.has(tag)) { el.remove(); continue; }

    // Lazy-loaded images keep the real URL in a data attribute.
    let lazySrc = null;
    if (tag === 'img') {
      lazySrc = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original');
    }

    clean(el, base);

    if (!KEEP.has(tag)) { el.replaceWith(...el.childNodes); continue; }

    const srcBefore = tag === 'img' ? lazySrc || el.getAttribute('src') : null;
    for (const a of [...el.attributes]) {
      if (!(ATTRS[tag] || []).includes(a.name)) el.removeAttribute(a.name);
    }

    if (tag === 'a') {
      const h = safeUrl(el.getAttribute('href'), base, { mail: true });
      if (h) { el.setAttribute('href', h); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      else el.removeAttribute('href');
    } else if (tag === 'img') {
      const s = safeUrl(srcBefore, base, { image: true });
      if (!s) { el.remove(); continue; }
      el.setAttribute('src', s);
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
      el.setAttribute('referrerpolicy', 'no-referrer');
    } else if (tag === 'video' || tag === 'audio') {
      const s = safeUrl(el.getAttribute('src'), base);
      if (s) el.setAttribute('src', s); else el.removeAttribute('src');
      if (tag === 'video') {
        const p = safeUrl(el.getAttribute('poster'), base, { image: true });
        if (p) el.setAttribute('poster', p); else el.removeAttribute('poster');
      }
      el.setAttribute('controls', '');
      el.setAttribute('preload', 'none');
    } else if (tag === 'source') {
      const s = safeUrl(el.getAttribute('src'), base);
      if (!s || !el.closest('video, audio')) { el.remove(); continue; }
      el.setAttribute('src', s);
    }
  }
}

export function sanitize(html, base = '') {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  clean(doc.body, base);
  return doc.body.innerHTML;
}
