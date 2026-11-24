import * as db from './db.js';
import { hash, hueFor, hostOf } from './util.js';

const ALL = { origins: ['<all_urls>'] };

export const feedIdFor = (url) => hash(url);
export const hasHosts = () => chrome.permissions.contains(ALL);
export const ensureHosts = async () => (await hasHosts()) || chrome.permissions.request(ALL);

/** The followed feed for this address, if any. Matches by id or by current url. */
export async function findFollowed(url) {
  const byId = await db.get('feeds', feedIdFor(url));
  if (byId) return byId;
  return (await db.all('feeds')).find((f) => f.url === url) || null;
}

/** Save a discovered feed. Returns { id, added } where added is false if already followed. */
export async function followFeed({ url, feed, kind }) {
  const existing = await findFollowed(url);
  if (existing) return { id: existing.id, added: false };
  const id = feedIdFor(url);
  const title = feed?.title || hostOf(url);
  await db.put('feeds', {
    id, url, title, siteUrl: feed?.siteUrl || '', hue: hueFor(title), folder: '',
    added: Date.now(), lastFetched: 0, error: null,
    ...(kind === 'page' ? { kind: 'page' } : {}),
  });
  return { id, added: true };
}

export const refreshFeedNow = (feedId) => chrome.runtime.sendMessage({ type: 'refresh', feedId }).catch(() => null);
export const openApp = (hash = '') => chrome.runtime.sendMessage({ type: 'open-app', hash }).catch(() => null);
