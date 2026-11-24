import { sanitize } from './sanitize.js';

const NOISE = [
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'svg', 'dialog', 'button',
  '[role="navigation"]', '[role="banner"]', '[role="complementary"]', '[aria-hidden="true"]',
  '.share', '.social', '.newsletter', '.advert', '.ads', '.comments', '#comments', '.related', '.sidebar', '.cookie',
].join(',');

const len = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().length;

/** Pull the main article out of a full HTML page. */
export function extract(html, baseUrl = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = (doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || '').trim();
  doc.querySelectorAll(NOISE).forEach((n) => n.remove());

  let best = doc.querySelector('article, [itemprop="articleBody"]');
  if (!best || len(best) < 400) {
    const scores = new Map();
    doc.querySelectorAll('p').forEach((p) => {
      const t = p.textContent.trim();
      if (t.length < 60) return;
      const s = 1 + (t.match(/[,，]/g) || []).length + Math.min(Math.floor(t.length / 100), 3);
      const parent = p.parentElement;
      if (!parent) return;
      scores.set(parent, (scores.get(parent) || 0) + s);
      const grand = parent.parentElement;
      if (grand) scores.set(grand, (scores.get(grand) || 0) + s / 2);
    });
    let top = 0;
    scores.forEach((v, k) => { if (v > top) { top = v; best = k; } });
  }
  best ||= doc.body;

  return {
    title,
    html: sanitize(best.innerHTML, baseUrl),
    text: (best.textContent || '').replace(/\s+/g, ' ').trim(),
  };
}
