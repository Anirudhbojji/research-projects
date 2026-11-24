import * as db from './lib/db.js';
import { fetchText, looksLikeFeed, probeUrls, ytFeed, originOf } from './lib/feed.js';
import { getSettings } from './lib/settings.js';
import { seedIfNeeded } from './lib/catalog.js';
import { hostOf, mutedMatcher } from './lib/util.js';
import { buildItems } from './lib/ingest.js';

// The toolbar icon opens the full Vangmayam page. The side panel is the "add this
// site" companion and opens from the shortcut or the right-click menus.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

const APP_URL = chrome.runtime.getURL('app.html');

async function openApp(hash = '') {
  const [existing] = await chrome.tabs.query({ url: APP_URL });
  const target = hash ? `${APP_URL}#${hash}` : APP_URL;
  if (existing) {
    await chrome.tabs.update(existing.id, hash ? { active: true, url: target } : { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: target });
  }
}

async function openFollowPanel(tab, pendingUrl) {
  if (!tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  if (pendingUrl) await chrome.storage.session.set({ pendingFollow: { url: pendingUrl, t: Date.now() } });
}

// Ollama rejects requests whose Origin is a browser extension. For the one address the
// person chose, present the request as coming from the same machine instead.
async function syncOllamaRule(url) {
  const s = url ? { ollamaUrl: url } : await getSettings();
  let origin;
  try { origin = new URL(s.ollamaUrl).origin; } catch { return false; }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'set', value: 'http://127.0.0.1' }] },
      condition: { urlFilter: `|${origin}/`, resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] },
    }],
  });
  return true;
}

async function schedule() {
  const s = await getSettings();
  await chrome.alarms.create('refresh', { periodInMinutes: Math.max(5, Number(s.refreshMinutes) || 20), delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  schedule();
  syncOllamaRule().catch(() => {});
  chrome.contextMenus.create({ id: 'follow', title: 'Follow this site in Vangmayam', contexts: ['page', 'link', 'action'] });
  await seedIfNeeded().catch(() => {});
  if (details.reason === 'install') openApp();
});
chrome.runtime.onStartup.addListener(() => { schedule(); syncOllamaRule().catch(() => {}); seedIfNeeded().catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) { schedule(); syncOllamaRule().catch(() => {}); }
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'refresh') refresh(); });

chrome.action.onClicked.addListener(() => openApp());

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'follow-here') return;
  const [active] = tab?.id ? [tab] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  openFollowPanel(active);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'follow') return;
  openFollowPanel(tab, info.linkUrl || null);
});

// The offscreen page parses XML and HTML because service workers have no DOMParser.
let creating = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'Parse RSS and Atom feeds' })
    .finally(() => { creating = null; });
  await creating;
}

async function offscreen(message) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  if (!r?.ok) throw new Error(r?.error || 'Could not read the page.');
  return r;
}
const parseRemote = async (xml, url) => (await offscreen({ type: 'parse', xml, url })).feed;
const linksRemote = async (html, url) => (await offscreen({ type: 'find-links', html, url })).links;
const pageRemote = async (html, url) => (await offscreen({ type: 'extract-page', html, url })).feed;

/** Read a page that has no feed: its article list becomes the items. */
async function fetchPage(feed, url) {
  const { text, url: finalUrl } = await fetchText(url, { trustedOrigin: originOf(feed.url) });
  const parsed = await pageRemote(text, finalUrl);
  return { url, parsed };
}

/** Look for a working feed starting from the site itself. */
async function resolveFeed(feed) {
  const site = feed.site || feed.siteUrl;
  if (!site) throw new Error('No feed found.');
  const trustedOrigin = originOf(feed.url);
  const page = await fetchText(site, { trustedOrigin });
  if (looksLikeFeed(page.text)) return { url: page.url, parsed: await parseRemote(page.text, page.url) };

  const candidates = [];
  if (/youtube\.com/.test(page.url)) {
    const m = page.text.match(/(?:"channelId"|"externalId"):"(UC[\w-]{22})"/) || page.text.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
    if (m) candidates.push(ytFeed(m[1]));
  }
  candidates.push(...(await linksRemote(page.text, page.url)), ...probeUrls(page.url));

  for (const c of [...new Set(candidates)].slice(0, 16)) {
    try {
      const r = await fetchText(c, { timeout: 8000, trustedOrigin });
      if (looksLikeFeed(r.text)) return { url: r.url, parsed: await parseRemote(r.text, r.url) };
    } catch { /* try the next one */ }
  }
  throw new Error(`No feed found for ${hostOf(site)}.`);
}

async function fetchParsed(feed) {
  if (feed.kind === 'page') {
    const r = await fetchPage(feed, feed.url);
    if (!r.parsed.items.length) throw new Error('No articles found on this page.');
    return r;
  }
  try {
    if (feed.discover) throw new Error('needs lookup');
    const { text, url } = await fetchText(feed.url, { trustedOrigin: originOf(feed.url) });
    if (!looksLikeFeed(text)) throw new Error('That address is not a feed.');
    // A redirect within the site becomes the stored address. One that leaves the site is followed
    // each time but not written down, so a hijacked or one-off redirect cannot repoint the source.
    return { url: originOf(url) === originOf(feed.url) ? url : feed.url, parsed: await parseRemote(text, url) };
  } catch (e) {
    if (!(feed.site || feed.siteUrl)) throw e;
    try {
      return await resolveFeed(feed);
    } catch (resolveError) {
      if (!feed.discover) throw e;
      // The site publishes no feed at all. Follow its article list instead.
      try {
        const r = await fetchPage(feed, feed.site || feed.siteUrl);
        if (r.parsed.items.length >= 3) return { ...r, becamePage: true };
      } catch { /* report the lookup failure below */ }
      throw resolveError;
    }
  }
}

async function refreshFeed(feed) {
  try {
    const result = await fetchParsed(feed);
    const current = await db.get('feeds', feed.id);
    if (!current) return 0; // unfollowed while fetching

    const now = Date.now();
    const settings = await getSettings();
    const fresh = buildItems(feed, result.parsed, {
      now,
      first: !current.lastFetched,
      known: new Set(await db.itemIdsForFeed(feed.id)),
      isMuted: mutedMatcher(settings.mutedWords),
      retentionDays: Number(settings.retentionDays),
    });

    await db.putMany('items', fresh);
    await db.put('feeds', {
      ...current,
      url: result.url,
      discover: false,
      ...(result.becamePage ? { kind: 'page' } : {}),
      title: current.preset ? current.title : current.title || result.parsed.title || result.url,
      siteUrl: current.siteUrl || result.parsed.siteUrl,
      lastFetched: now,
      error: null,
    });
    return fresh.length;
  } catch (e) {
    const current = await db.get('feeds', feed.id);
    if (current) await db.put('feeds', { ...current, error: String(e.message || e) });
    return 0;
  }
}

async function doRefresh(only) {
  // Without access to the sites, every fetch would fail. Wait for the person to allow it.
  if (!(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) return 0;

  const feeds = (await db.all('feeds')).filter((f) => !only || f.id === only);
  const queue = [...feeds];
  let added = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) added += await refreshFeed(queue.shift());
    }),
  );
  const s = await getSettings();
  await db.prune(Number(s.retentionDays));
  await updateBadge();
  chrome.runtime.sendMessage({ type: 'feeds-updated' }).catch(() => {});
  return added;
}

let chain = Promise.resolve();
function refresh(only) {
  const p = chain.then(() => doRefresh(only));
  chain = p.catch(() => {});
  return p;
}

async function updateBadge() {
  const n = await db.unreadTotal();
  await chrome.action.setBadgeBackgroundColor({ color: '#2F4FE0' });
  await chrome.action.setBadgeText({ text: n ? (n > 999 ? '999+' : String(n)) : '' });
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.target === 'offscreen') return;
  if (msg?.type === 'refresh') {
    refresh(msg.feedId).then((added) => send({ ok: true, added }), (e) => send({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'ollama-rule') {
    syncOllamaRule(msg.url).then((ok) => send({ ok }), (e) => send({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'open-app') {
    openApp(msg.hash || '').then(() => send({ ok: true }), () => send({ ok: false }));
    return true;
  }
  if (msg?.type === 'badge') {
    updateBadge().then(() => send({ ok: true }), () => send({ ok: false }));
    return true;
  }
});
