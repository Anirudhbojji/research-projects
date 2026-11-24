export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const hueFor = (s) => parseInt(hash(String(s)), 36) % 360;

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
};

export function timeAgo(ms) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return Math.floor(d / 60) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h';
  if (d < 604800) return Math.floor(d / 86400) + 'd';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayLabel(ms) {
  const sod = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((sod(new Date()) - sod(new Date(ms))) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/** Tiny, safe markdown: paragraphs, bullets, **bold**, headings, and [n] citations. */
export function md(src = '') {
  const cite = (t) =>
    t.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (_, g) =>
      g.split(',').map((n) => `<button type="button" class="cite" data-cite="${n.trim()}">${n.trim()}</button>`).join(''));
  const inline = (t) => cite(t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'));
  const out = [];
  let inList = false;
  for (const raw of esc(src).split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)/);
    out.push(h ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

/** "today", "yesterday", "5 days ago", "3 months ago". */
export function daysAgo(ms) {
  const sod = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const d = Math.round((sod(new Date()) - sod(new Date(ms))) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 45) return `${d} days ago`;
  const m = Math.round(d / 30);
  return m < 12 ? `${m} months ago` : `${Math.round(d / 365)} ${Math.round(d / 365) === 1 ? 'year' : 'years'} ago`;
}

/** Build a test from a comma or line separated list of words to hide. Whole words, any case. */
export function mutedMatcher(list = '') {
  const words = list.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
  if (!words.length) return () => false;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped.join('|')})($|[^\\p{L}\\p{N}])`, 'iu');
  return (text) => re.test(text || '');
}

/** Only http and https addresses are safe to put in a link. */
export const httpUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
