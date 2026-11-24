import { parseFeed, feedLinksFromHtml } from './parse.js';
import { extractPageItems } from './pagefeed.js';
import { hostOf } from './util.js';

export async function fetchText(url, { timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      credentials: 'omit',
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' },
    });
    if (!r.ok) throw new Error(`The site answered with HTTP ${r.status}.`);
    return { text: await r.text(), url: r.url };
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

async function tryCandidates(urls) {
  const settled = await Promise.allSettled(
    urls.slice(0, 14).map(async (u) => {
      const r = await fetchText(u);
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
async function pageSources(page) {
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
      const r = await fetchText(c, { timeout: 8000 });
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
  const isYouTube = /(^|\.)youtube\.com$/.test(u.hostname);

  const channel = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (isYouTube && channel) {
    const direct = await tryCandidates([ytFeed(channel[1])]);
    if (direct.length) return direct;
  }

  if (/(^|\.)reddit\.com$/.test(u.hostname)) {
    const m = u.pathname.match(/^\/(r|user)\/[^/]+/);
    if (m && !u.pathname.endsWith('.rss')) url = `https://www.reddit.com${m[0]}/.rss`;
  }

  const page = await fetchText(url);
  if (looksLikeFeed(page.text)) return [{ url: page.url, feed: parseFeed(page.text, page.url) }];

  const linked = new Set(feedLinksFromHtml(page.text, page.url));
  if (isYouTube) {
    const m = page.text.match(/(?:"channelId"|"externalId"):"(UC[\w-]{22})"/) || page.text.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
    if (m) linked.add(ytFeed(m[1]));
  }

  let found = linked.size ? await tryCandidates([...linked]) : [];
  if (!found.length) found = await tryCandidates(probeUrls(page.url));
  if (found.length) return found;

  const pages = await pageSources(page);
  if (pages.length) return pages;
  throw new Error('No feed or article list found there. Try the site’s blog or news page.');
}
