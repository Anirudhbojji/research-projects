import { parseFeed, feedLinksFromHtml } from './parse.js';
import { extractPageItems } from './pagefeed.js';
import { hostOf } from './util.js';

/** Feeds and pages larger than this are not read. Articles rarely pass 1 MB; a hostile site can send gigabytes. */
export const MAX_BYTES = 5 * 1024 * 1024;

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0))
    || (a === 198 && (b === 18 || b === 19));
}

/**
 * True for this machine and private networks: loopback, RFC 1918, link-local, CGNAT, multicast,
 * IPv6 equivalents, and names that never leave the local network. Names are not resolved, so a public
 * name that points at a private address is not caught; the browser's own protections cover that case.
 */
export function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    // IPv4-mapped addresses: the URL parser writes them as ::ffff:7f00:1, pages may write ::ffff:127.0.0.1.
    const dotted = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateV4(dotted[1]);
    const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateV4(h);
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || h.endsWith('.home.arpa') || !h.includes('.');
}

export const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

/**
 * Only http(s). A private or local address is loaded only when it is on the same origin as something
 * the person typed or chose to follow (`trustedOrigin`), never because a feed or page pointed there.
 */
function assertAllowed(url, trustedOrigin) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That is not a valid web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https addresses can be loaded.');
  if (isPrivateHost(u.hostname) && u.origin !== trustedOrigin) {
    throw new Error(`Vangmayam does not load private or local addresses (${u.hostname}) that a site or feed points to.`);
  }
  return u;
}

async function readCapped(r, maxBytes) {
  const tooBig = () => new Error(`The page is larger than ${Math.round(maxBytes / 1048576)} MB, so Vangmayam did not read it.`);
  if (Number(r.headers.get('content-length')) > maxBytes) throw tooBig();
  if (!r.body) return r.text();
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) { reader.cancel().catch(() => {}); throw tooBig(); }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

/**
 * Load a page or feed as text. Options: `timeout` ms, `maxBytes`, and `trustedOrigin`, the origin the
 * person asked for, which is the only origin allowed to be private or local (see assertAllowed).
 * The address the browser ends on after redirects is checked the same way.
 */
export async function fetchText(url, { timeout = 15000, maxBytes = MAX_BYTES, trustedOrigin = '' } = {}) {
  assertAllowed(url, trustedOrigin);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      credentials: 'omit',
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' },
    });
    if (!r.ok) throw new Error(`The site answered with HTTP ${r.status}.`);
    const finalUrl = r.url || url;
    assertAllowed(finalUrl, trustedOrigin);
    return { text: await readCapped(r, maxBytes), url: finalUrl };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The site took too long to respond.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const FEED_HINT = /<(?:rss|feed|rdf:RDF)[\s>]/i;
export const looksLikeFeed = (t) => FEED_HINT.test(t.slice(0, 4000));

export function normalizeInput(raw) {
  const s = raw.trim();
  if (!s) throw new Error('Enter a website, channel or subreddit.');
  if (/^\/?r\/\w+/i.test(s)) return `https://www.reddit.com/${s.replace(/^\//, '')}/.rss`.replace(/\/+\.rss$/, '/.rss');
  if (/^@[\w.-]+$/.test(s)) return `https://www.youtube.com/${s}`;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new Error('That does not look like a web address.'); }
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('That does not look like a web address.');
  return u.href;
}

/* Query parameters that name a page rather than a person. Everything else is dropped before the panel re-opens a tab's address. */
const PAGE_PARAMS = new Set(['v', 'list', 'channel_id', 'feed', 'format', 'p', 'page_id', 'cat', 'tag']);
/* Parameter names and path segments that mark sign-in, reset, unsubscribe and other one-time links. */
const SECRET_PARAM = /token|key|auth|code|sig|session|sid|pass|secret|nonce|state|otp|verif|confirm|reset|unsub|ticket|jwt|login|magic|invit|activ|hash|expir/i;
const SECRET_PATH = /^(login|signin|sign-in|logout|auth|oauth|sso|reset|reset-password|forgot|forgot-password|unsubscribe|verify|verification|confirm|activate|magic|magic-link|invite|invitation)$/i;
/* A long run of letters and digits with no hyphen is far more often a token than a slug. */
const looksLikeToken = (s) => /^[0-9a-f]{32,}$/i.test(s) || (/^[A-Za-z0-9_=.%+/]{24,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s));

/**
 * The address the side panel may request on its own for a tab it was not asked about.
 * Returns `{ url }` with the query reduced to page-naming parameters and the fragment removed, or
 * `{ skip }` with the reason the page is left alone: `scheme` (not http(s)), `private` (this machine or
 * the local network) or `sensitive` (the address looks like a sign-in, reset, unsubscribe or other
 * one-time link, which must not be requested a second time). Nothing is fetched here.
 */
export function autoDiscoveryUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { skip: 'scheme' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { skip: 'scheme' };
  if (isPrivateHost(u.hostname)) return { skip: 'private' };
  if (u.username || u.password) return { skip: 'sensitive' };
  if (u.pathname.split('/').some((s) => SECRET_PATH.test(s) || looksLikeToken(s))) return { skip: 'sensitive' };
  const kept = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (SECRET_PARAM.test(k) || looksLikeToken(v)) return { skip: 'sensitive' };
    if (PAGE_PARAMS.has(k.toLowerCase()) && v.length <= 64) kept.set(k, v);
  }
  u.search = kept.toString();
  u.hash = '';
  u.username = '';
  u.password = '';
  return { url: u.href };
}

async function tryCandidates(urls, trustedOrigin) {
  const settled = await Promise.allSettled(
    urls.slice(0, 14).map(async (u) => {
      const r = await fetchText(u, { trustedOrigin });
      if (!looksLikeFeed(r.text)) throw new Error('not a feed');
      return { url: r.url, feed: parseFeed(r.text, r.url) };
    }),
  );
  const seen = new Set();
  return settled
    .filter((x) => x.status === 'fulfilled')
    .map((x) => x.value)
    .filter((x) => !seen.has(x.url) && seen.add(x.url));
}

const PROBE_PATHS = ['/feed', '/feed/', '/rss', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml'];

/** Likely feed addresses for a page: under the page path first, then at the site root. */
export function probeUrls(pageUrl) {
  const u = new URL(pageUrl);
  const out = new Set();
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  if (u.pathname.length > 1) PROBE_PATHS.forEach((p) => out.add(base + p));
  PROBE_PATHS.forEach((p) => out.add(u.origin + p));
  return [...out];
}

export const ytFeed = (id) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;

/**
 * For a site with no feed: the pages whose article list can be followed instead.
 * An article page is not a list, so look for the site's blog or news page in that case.
 */
async function pageSources(page, trustedOrigin) {
  const out = [];
  const seen = new Set();
  const add = (url, r) => {
    if (seen.has(url) || r.items.length < 3) return;
    seen.add(url);
    out.push({ url, kind: 'page', feed: { title: r.title || hostOf(url), siteUrl: url, items: r.items } });
  };
  const here = extractPageItems(page.text, page.url);
  if (!here.looksLikeArticle) add(page.url, here);
  if (out.length) return out;

  const origin = new URL(page.url).origin;
  const parent = new URL('.', page.url).href.replace(/\/$/, '');
  const same = (a, b) => a.replace(/\/$/, '') === b.replace(/\/$/, '');
  for (const c of [...new Set([parent, `${origin}/blog`, `${origin}/news`, `${origin}/articles`, `${origin}/posts`, `${origin}/`])]) {
    if (out.length >= 2) break;
    if (same(c, page.url)) continue;
    try {
      const r = await fetchText(c, { timeout: 8000, trustedOrigin });
      const x = extractPageItems(r.text, r.url);
      if (!x.looksLikeArticle) add(r.url, x);
    } catch { /* try the next page */ }
  }
  return out;
}

/** Resolve whatever the person typed into one or more feeds with a parsed preview. */
export async function discover(raw) {
  let url = normalizeInput(raw);
  const u = new URL(url);
  // The person asked for this origin, so it may be local; nothing it links to may be.
  const trustedOrigin = u.origin;
  const isYouTube = /(^|\.)youtube\.com$/.test(u.hostname);

  const channel = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (isYouTube && channel) {
    const direct = await tryCandidates([ytFeed(channel[1])], trustedOrigin);
    if (direct.length) return direct;
  }

  if (/(^|\.)reddit\.com$/.test(u.hostname)) {
    const m = u.pathname.match(/^\/(r|user)\/[^/]+/);
    if (m && !u.pathname.endsWith('.rss')) url = `https://www.reddit.com${m[0]}/.rss`;
  }

  const page = await fetchText(url, { trustedOrigin });
  if (looksLikeFeed(page.text)) return [{ url: page.url, feed: parseFeed(page.text, page.url) }];

  const linked = new Set(feedLinksFromHtml(page.text, page.url));
  if (isYouTube) {
    const m = page.text.match(/(?:"channelId"|"externalId"):"(UC[\w-]{22})"/) || page.text.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
    if (m) linked.add(ytFeed(m[1]));
  }

  let found = linked.size ? await tryCandidates([...linked], trustedOrigin) : [];
  if (!found.length) found = await tryCandidates(probeUrls(page.url), trustedOrigin);
  if (found.length) return found;

  const pages = await pageSources(page, trustedOrigin);
  if (pages.length) return pages;
  throw new Error('No feed or article list found there. Try the site’s blog or news page.');
}
