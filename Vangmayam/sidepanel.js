import * as db from './lib/db.js';
import { discover } from './lib/feed.js';
import { followFeed, findFollowed, hasHosts, ensureHosts, refreshFeedNow, openApp } from './lib/follow.js';
import { hydrateIcons } from './lib/icons.js';
import { $, esc, hostOf, hueFor, timeAgo } from './lib/util.js';

hydrateIcons();

const P = { token: 0, pinned: null, found: [], lastUrl: '' };
const stateEl = $('#state');
const toastEl = $('#toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

const when = (ms) => {
  if (!ms) return '';
  const a = timeAgo(ms);
  if (a === 'now') return 'just now';
  return Date.now() - ms < 7 * 864e5 ? `${a} ago` : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/* ---------- the page card ---------- */
function setSite({ title, host = '', favicon = '' }) {
  const box = $('#site-icon');
  const letter = (host || title || '?').replace(/^www\./, '').charAt(0).toUpperCase();
  box.style.setProperty('--h', hueFor(host || title || 'x'));
  box.textContent = letter;
  if (/^https?:/.test(favicon)) {
    const img = new Image();
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { box.textContent = ''; box.append(img); };
    img.src = favicon;
  }
  $('#site-title').textContent = title || host || 'This page';
  $('#site-host').textContent = host;
}

const note = (html) => { stateEl.innerHTML = `<p class="note">${html}</p>`; };
const skeleton = () => { stateEl.innerHTML = '<div class="skel" aria-label="Looking for feeds"><i></i><i></i></div>'; };

/* ---------- finding feeds ---------- */
async function getTarget() {
  if (P.pinned) return P.pinned;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? { url: tab.url || '', title: tab.title || '', favicon: tab.favIconUrl || '' } : null;
}

async function detect(force = false) {
  const my = ++P.token;
  const t = await getTarget();
  if (my !== P.token) return;
  if (!t) { setSite({ title: 'No page open' }); note('Open a website, then come back here to follow it.'); return; }

  const own = t.url.startsWith(chrome.runtime.getURL('app.html'));
  if (own) {
    setSite({ title: 'You’re in Vangmayam' });
    note('This is your reading page. Switch to a website and its feeds show up here.');
    P.lastUrl = '';
    return;
  }
  if (!t.raw && !/^https?:/i.test(t.url)) {
    setSite({ title: t.title || 'This page' });
    note('Vangmayam can only follow websites. Open a site, YouTube channel or subreddit, then come back.');
    P.lastUrl = '';
    return;
  }
  if (!force && t.url === P.lastUrl && P.found.length) return;
  P.lastUrl = t.url;

  const host = t.raw ? '' : hostOf(t.url);
  setSite({ title: t.title || host, host, favicon: t.favicon });

  if (!(await hasHosts())) {
    stateEl.innerHTML =
      '<p class="note">To look for feeds, Vangmayam needs permission to read the sites you visit. It only reads a page when you open this panel on it.</p>' +
      '<button class="pill primary" type="button" data-allow>Allow access</button>';
    return;
  }

  skeleton();
  try {
    const found = await discover(t.url);
    if (my !== P.token) return;
    P.found = found;
    await renderFound();
  } catch (e) {
    if (my !== P.token) return;
    P.found = [];
    const why = /failed to fetch/i.test(e.message) ? 'Vangmayam could not load this page.' : e.message;
    note(`<b>Nothing to follow here.</b> ${esc(why)} You can paste a link below.`);
  }
}

async function renderFound() {
  const rows = await Promise.all(P.found.map(async (r, i) => {
    const following = !!(await findFollowed(r.url));
    const title = r.feed.title || hostOf(r.url);
    const items = r.feed.items;
    const latest = Math.max(0, ...items.map((x) => x.published || 0));
    const peek = items.slice(0, 3).map((x) => `<li>${esc(x.title || 'Untitled')}</li>`).join('');
    const page = r.kind === 'page';
    return `<li class="cand" style="--h:${hueFor(title)}">` +
      `<div class="cand-main"><b>${esc(title)}</b><small>${page ? `${items.length} articles found on the page` : `${items.length} posts${latest ? `, latest ${when(latest)}` : ''}`}</small>${page ? '<small class="tag">No feed. Vangmayam follows the page.</small>' : ''}</div>` +
      (following ? '<button class="pill done" type="button" disabled>Following</button>' : `<button class="pill primary" type="button" data-follow="${i}">Follow</button>`) +
      (peek ? `<ul class="peek">${peek}</ul>` : '') + '</li>';
  }));
  const lead = P.found.some((r) => r.kind === 'page')
    ? '<p class="note"><b>This site has no feed.</b> Vangmayam can follow its article list and pick up new articles as they appear.</p>'
    : P.found.length > 1 ? '<p class="note">This page offers a few feeds. Follow the ones you want.</p>' : '';
  stateEl.innerHTML = `${lead}<ul class="cands">${rows.join('')}</ul>`;
}

function showAdded(r, id) {
  stateEl.querySelector('.added')?.remove();
  const title = r.feed.title || hostOf(r.url);
  stateEl.insertAdjacentHTML('afterbegin',
    `<div class="added"><p><b>${esc(title)}</b> is in Vangmayam. Its posts are loading.</p><button class="pill primary" type="button" data-open="${esc(id)}">Open in Vangmayam</button></div>`);
}

/* ---------- recent ---------- */
async function loadRecent() {
  const feeds = (await db.all('feeds')).sort((a, b) => b.added - a.added).slice(0, 5);
  $('#recent').hidden = !feeds.length;
  if (!feeds.length) return;
  const counts = await db.unreadCounts();
  $('#recent-list').innerHTML = feeds.map((f) =>
    `<li><button type="button" data-open="${esc(f.id)}" style="--h:${f.hue}"><span class="dot" style="--h:${f.hue}"></span><span class="name">${esc(f.title || hostOf(f.url))}</span><span class="count">${counts[f.id] || ''}</span></button></li>`).join('');
}

/* ---------- events ---------- */
stateEl.addEventListener('click', async (e) => {
  const allow = e.target.closest('[data-allow]');
  if (allow) {
    if (await chrome.permissions.request({ origins: ['<all_urls>'] })) detect(true);
    else note('Without access Vangmayam cannot look for feeds. You can allow it any time from here.');
    return;
  }
  const btn = e.target.closest('[data-follow]');
  if (btn) {
    btn.disabled = true;
    const r = P.found[Number(btn.dataset.follow)];
    const res = await followFeed(r);
    btn.textContent = 'Following';
    btn.className = 'pill done';
    showAdded(r, res.id);
    refreshFeedNow(res.id).then(loadRecent);
    loadRecent();
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) openApp(`feed=${open.dataset.open}`);
});

$('#recent-list').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) openApp(`feed=${open.dataset.open}`);
});
$('#open-app').addEventListener('click', () => openApp());

$('#manual').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#manual-input').value.trim();
  if (!v) return;
  await ensureHosts();
  P.pinned = { url: v, title: v, favicon: '', raw: true };
  detect(true);
});

let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => detect(false), 350); };
chrome.tabs.onActivated.addListener(() => { P.pinned = null; schedule(); });
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && !P.pinned && (info.status === 'complete' || info.url)) schedule();
});
chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'feeds-updated') loadRecent(); });

async function takePending() {
  const { pendingFollow } = await chrome.storage.session.get('pendingFollow');
  if (pendingFollow && Date.now() - pendingFollow.t < 30000) {
    await chrome.storage.session.remove('pendingFollow');
    P.pinned = { url: pendingFollow.url, title: '', favicon: '' };
    detect(true);
    return true;
  }
  return false;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.pendingFollow?.newValue) takePending();
});

(async function boot() {
  loadRecent();
  if (!(await takePending())) detect(true);
})();
