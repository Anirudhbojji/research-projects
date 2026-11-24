import * as db from './lib/db.js';
import { discover, fetchText } from './lib/feed.js';
import { extract } from './lib/readable.js';
import { sanitize } from './lib/sanitize.js';
import * as ai from './lib/ai.js';
import { getSettings, saveSettings, DEFAULTS } from './lib/settings.js';
import { followFeed, ensureHosts, hasHosts, refreshFeedNow } from './lib/follow.js';
import { PACKS, CATALOG_INDEX, catalogId, addCatalogSource, seedIfNeeded } from './lib/catalog.js';
import { icon, hydrateIcons } from './lib/icons.js';
import { $, $$, esc, hash, hueFor, timeAgo, dayLabel, daysAgo, mutedMatcher, httpUrl, md, hostOf } from './lib/util.js';

hydrateIcons();


/* ---------- state ---------- */
const S_COLLAPSED = new Set();
// Layout choices were saved under the old name (fathom.*). Read those when the new keys are empty.
const stored = (key, old) => localStorage.getItem(key) ?? localStorage.getItem(old);
try { JSON.parse(stored('raman.collapsed', 'fathom.collapsed') || '[]').forEach((f) => S_COLLAPSED.add(f)); } catch { /* start expanded */ }
const S = {
  nav: 'unread', // 'brief' | 'unread' | 'all' | 'starred' | 'feed'
  view: 'unread', // which items the list shows: unread | all | starred
  feedId: null,
  folder: null,
  srcQ: '',
  packsQ: '',
  collapsed: S_COLLAPSED,
  q: '',
  feeds: new Map(),
  items: [],
  counts: {},
  sel: -1,
  cur: null,
  pane: 'home', // 'home' | 'article'
  chat: [],
  articleText: '',
  feedText: '',
  briefIds: [],
  found: [],
};

const shell = $('#shell');
const toastEl = $('#toast');
let toastTimer;
function toast(msg, action) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('has-act', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { toastEl.classList.remove('show'); action.run(); });
    toastEl.append(b);
  }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), action ? 7000 : 2600);
}

const textOf = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
const badge = () => chrome.runtime.sendMessage({ type: 'badge' }).catch(() => {});
const feedName = (f) => f.title || hostOf(f.url);
const siteOf = (f) => httpUrl(f.siteUrl) || httpUrl(f.site) || (() => { try { return new URL(f.url).origin; } catch { return ''; } })();

/* ---------- reading preferences ---------- */
const prefs = { measure: 'wide', size: 19, hideRail: false, hideList: false };
try { Object.assign(prefs, JSON.parse(stored('raman.prefs', 'fathom.prefs') || '{}')); } catch { /* defaults */ }
const savePrefs = () => { try { localStorage.setItem('raman.prefs', JSON.stringify(prefs)); } catch { /* not saved */ } };
const MEASURES = ['comfortable', 'wide', 'full'];
const SIZES = [16, 17, 18, 19, 20, 22, 24];

function applyPrefs() {
  const reading = S.pane === 'article';
  shell.dataset.measure = prefs.measure;
  shell.style.setProperty('--read-size', `${prefs.size}px`);
  // The panes only fold away while an article is open; the list and library come back with the brief.
  shell.dataset.hideRail = String(reading && prefs.hideRail);
  shell.dataset.hideList = String(reading && prefs.hideList);
  $('#t-rail').setAttribute('aria-pressed', String(prefs.hideRail));
  $('#t-list').setAttribute('aria-pressed', String(prefs.hideList));
  $('#t-focus').setAttribute('aria-pressed', String(prefs.hideRail && prefs.hideList));
  $('#t-measure').title = `Reading width: ${prefs.measure}. Click to change`;
}
function togglePane(which) {
  prefs[which] = !prefs[which];
  savePrefs();
  applyPrefs();
}
function toggleFocus() {
  const both = prefs.hideRail && prefs.hideList;
  prefs.hideRail = prefs.hideList = !both;
  savePrefs();
  applyPrefs();
}
function cycleMeasure() {
  prefs.measure = MEASURES[(MEASURES.indexOf(prefs.measure) + 1) % MEASURES.length];
  savePrefs();
  applyPrefs();
  toast(`Reading width: ${prefs.measure}`);
}
function stepSize(dir) {
  const i = Math.max(0, SIZES.indexOf(prefs.size));
  prefs.size = SIZES[Math.max(0, Math.min(SIZES.length - 1, i + dir))];
  savePrefs();
  applyPrefs();
}

/* ---------- data ---------- */
function predicate() {
  const q = S.q.trim().toLowerCase();
  return (it) => {
    if (it.hidden || !S.feeds.has(it.feedId)) return false;
    if (S.feedId && it.feedId !== S.feedId) return false;
    if (S.folder && S.feeds.get(it.feedId).folder !== S.folder) return false;
    if (S.view === 'unread' && it.read) return false;
    if (S.view === 'starred' && !it.starred) return false;
    if (q && !`${it.title} ${it.summary} ${feedName(S.feeds.get(it.feedId))}`.toLowerCase().includes(q)) return false;
    return true;
  };
}
async function loadFeeds() {
  S.feeds = new Map((await db.all('feeds')).map((f) => [f.id, f]));
  S.counts = await db.unreadCounts();
}
async function loadItems() {
  const keep = S.items[S.sel]?.id;
  S.items = await db.queryItems(predicate(), 300);
  S.sel = keep ? S.items.findIndex((i) => i.id === keep) : -1;
}
async function reload() {
  await loadFeeds();
  await loadItems();
  render();
  checkAccess();
}
function bump(feedId, delta) {
  S.counts[feedId] = Math.max(0, (S.counts[feedId] || 0) + delta);
  renderRail();
  badge();
}
const totalUnread = () => Object.values(S.counts).reduce((a, b) => a + b, 0);

/* ---------- rendering ---------- */
function render() {
  renderRail();
  renderListHead();
  renderList();
  renderPane();
}

function renderRail() {
  const n = totalUnread();
  $('#n-unread').textContent = n ? (n > 999 ? '999+' : n) : '';
  $$('#nav button').forEach((b) => {
    if (b.dataset.nav === S.nav) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });

  if (!S.feeds.size) { $('#sources').innerHTML = '<li class="folder-label">No sources yet</li>'; return; }
  const packOrder = new Map(PACKS.map((p, i) => [p.name, i]));
  const rank = (f) => (f.folder ? (packOrder.has(f.folder) ? packOrder.get(f.folder) : 100) : -1);
  const q = S.srcQ.trim().toLowerCase();
  $('#rail-filter').hidden = S.feeds.size < 6 && !q;
  const matches = (f) => !q || `${feedName(f)} ${f.folder || ''} ${hostOf(f.siteUrl || f.url)}`.toLowerCase().includes(q);
  const feeds = [...S.feeds.values()].filter(matches).sort((a, b) => rank(a) - rank(b) || (a.folder || '').localeCompare(b.folder || '') || feedName(a).localeCompare(feedName(b)));
  if (!feeds.length) { $('#sources').innerHTML = `<li class="folder-label">No source matches “${esc(S.srcQ.trim())}”</li>`; return; }
  const folderCount = {};
  for (const f of feeds) folderCount[f.folder || ''] = (folderCount[f.folder || ''] || 0) + (S.counts[f.id] || 0);

  let lastFolder = null;
  const rows = [];
  for (const f of feeds) {
    const folder = f.folder || '';
    if (folder !== lastFolder) {
      lastFolder = folder;
      if (folder) {
        const open = q ? true : !S.collapsed.has(folder);
        const n = folderCount[folder];
        rows.push(
          `<li class="folder ${S.folder === folder ? 'on' : ''}"><button type="button" class="chev" data-fold="${esc(folder)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(folder)}">${icon('chevron', 14)}</button>` +
          `<button type="button" class="folder-name" data-folder="${esc(folder)}"><span>${esc(folder)}</span><span class="count">${n || ''}</span></button></li>`,
        );
      }
    }
    if (folder && !q && S.collapsed.has(folder)) continue;
    const c = S.counts[f.id] || 0;
    rows.push(
      `<li class="src ${S.feedId === f.id ? 'on' : ''} ${folder ? 'nested' : ''}" style="--h:${f.hue}">` +
      `<button type="button" class="src-main" data-feed="${esc(f.id)}" ${f.error ? `title="${esc(f.error)}"` : f.kind === 'page' ? 'title="This site has no feed. Vangmayam follows its article list."' : ''}><span class="dot"></span><span class="name">${esc(feedName(f))}</span>${f.error ? '<span class="warn"></span>' : ''}<span class="count">${c || ''}</span></button>` +
      `<button type="button" class="icon sm del" data-del="${esc(f.id)}" aria-label="Unfollow ${esc(feedName(f))}" title="Unfollow">${icon('trash', 15)}</button></li>`,
    );
  }
  $('#sources').innerHTML = rows.join('');
}

function renderListHead() {
  const f = S.feedId && S.feeds.get(S.feedId);
  const el = $('#list-title');
  if (!f) { el.textContent = S.folder || { unread: 'Unread', all: 'All articles', starred: 'Saved' }[S.view]; return; }
  const site = siteOf(f);
  el.innerHTML = site
    ? `<a class="title-link" href="${esc(site)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(feedName(f))} in a new tab"><span>${esc(feedName(f))}</span>${icon('external', 16)}</a>`
    : esc(feedName(f));
}

function renderList() {
  const list = $('#list');
  const empty = $('#empty');
  if (!S.items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    let h, p, action = '';
    const neverLoaded = S.feeds.size && [...S.feeds.values()].every((f) => !f.lastFetched);
    if (neverLoaded && !S.q.trim()) { h = 'Waiting for the first load'; p = 'Your sources are saved. Posts appear as soon as Vangmayam can read them.'; action = '<button class="pill" type="button" data-act="refresh">Load now</button>'; }
    else if (!S.feeds.size) { h = 'Nothing to read yet'; p = 'Follow a source and its posts appear here.'; action = '<button class="pill primary" type="button" data-act="add">Follow a source</button>'; }
    else if (S.q.trim()) { h = 'No matches'; p = 'Try a different word, or search All articles.'; }
    else if (S.view === 'starred') { h = 'Nothing saved yet'; p = 'Press s on any article to save it. Saved articles are never deleted.'; }
    else if (S.view === 'unread') { h = 'You’re caught up'; p = 'Nothing unread right now.'; action = '<button class="pill" type="button" data-act="all">Open all articles</button>'; }
    else { h = 'Nothing here yet'; p = 'New posts appear after the next refresh.'; action = '<button class="pill" type="button" data-act="refresh">Refresh now</button>'; }
    empty.innerHTML = `<h2>${h}</h2><p>${p}</p>${action}`;
    return;
  }
  empty.hidden = true;
  let last = '';
  const out = [];
  S.items.forEach((it, i) => {
    const d = dayLabel(it.published);
    if (d !== last) {
      const ago = d === 'Today' || d === 'Yesterday' ? '' : `<span class="ago">${daysAgo(it.published)}</span>`;
      out.push(`<li class="day" role="presentation">${esc(d)}${ago}</li>`);
      last = d;
    }
    out.push(rowHtml(it, i));
  });
  list.innerHTML = out.join('');
}

function rowHtml(it, i) {
  const f = S.feeds.get(it.feedId);
  const thumb = it.image && /^https?:/.test(it.image) ? `<img class="thumb" src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
  const isOpen = S.pane === 'article' && S.cur?.id === it.id;
  const read = !!it.read;
  const saved = !!it.starred;
  return `<li><article class="item ${isOpen ? 'open' : ''} ${i === S.sel ? 'sel' : ''}" tabindex="0" data-id="${esc(it.id)}" data-i="${i}" data-read="${read}" style="--h:${f.hue}">` +
    `<span class="edge"></span><div><div class="meta"><span class="src-name">${esc(feedName(f))}</span><time title="${esc(new Date(it.published).toLocaleString())}">${timeAgo(it.published)}</time>${saved ? `<span class="star" title="Saved">${icon('bookmark', 12)}</span>` : ''}</div>` +
    `<h3 class="title">${esc(it.title)}</h3>${it.summary ? `<p class="snip">${esc(it.summary)}</p>` : ''}</div>${thumb}` +
    `<div class="row-actions" role="group" aria-label="Article actions">` +
    `<button type="button" class="ra" data-row="save" aria-pressed="${saved}" title="${saved ? 'Remove from saved' : 'Save'} (s)" aria-label="${saved ? 'Remove from saved' : 'Save'}">${icon('bookmark', 15)}</button>` +
    `<button type="button" class="ra" data-row="read" title="${read ? 'Mark as unread' : 'Mark as read'} (m)" aria-label="${read ? 'Mark as unread' : 'Mark as read'}">${icon(read ? 'dot' : 'check', 15)}</button>` +
    `<button type="button" class="ra danger" data-row="hide" title="Not interested (x)" aria-label="Not interested">${icon('eyeoff', 15)}</button>` +
    `</div></article></li>`;
}

function refreshRow(it) {
  const el = $(`.item[data-id="${CSS.escape(it.id)}"]`);
  if (el) el.closest('li').outerHTML = rowHtml(it, Number(el.dataset.i));
}

function renderPane() {
  $('#home').hidden = S.pane !== 'home';
  $('#reader').hidden = S.pane !== 'article';
  const hasFeeds = S.feeds.size > 0;
  $('#home-main').hidden = !hasFeeds;
  $('#home-empty').hidden = hasFeeds;
  $('#home-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  applyPrefs();
}

function selectRow(i, scroll = true) {
  $$('.item.sel').forEach((el) => el.classList.remove('sel'));
  if (!S.items.length) return;
  S.sel = Math.max(0, Math.min(S.items.length - 1, i));
  const el = $(`.item[data-i="${S.sel}"]`);
  if (el) { el.classList.add('sel'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
}

/* ---------- navigation ---------- */
function setRail(open) { shell.dataset.rail = String(open); }
function setPaneOpen(open) { shell.dataset.open = String(open); }

async function go(nav, feedId = null, folder = null) {
  S.nav = nav;
  S.feedId = feedId;
  S.folder = folder;
  S.view = nav === 'brief' ? 'unread' : nav === 'feed' || nav === 'folder' ? 'all' : nav;
  if (nav === 'brief') { S.pane = 'home'; setPaneOpen(true); } else setPaneOpen(false);
  setRail(false);
  await loadItems();
  render();
}

/* ---------- brief ---------- */
function setBrief(text, ids, when) {
  S.briefIds = ids || [];
  $('#brief-out').innerHTML = text ? md(text) : '';
  $('#brief-when').textContent = when
    ? `Written ${new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'A short read on what is new across your sources.';
  $('#brief-go-label').textContent = text ? 'Rewrite' : 'Write brief';
}

async function writeBrief() {
  const rows = await db.queryItems((it) => !it.read && !it.hidden && S.feeds.has(it.feedId), 60);
  if (!rows.length) { toast('Nothing unread to summarize'); return; }
  const input = rows.map((it) => ({ source: feedName(S.feeds.get(it.feedId)), title: it.title, summary: it.summary }));
  const ids = rows.map((it) => it.id);
  const box = $('#brief');
  const btn = $('#brief-go');
  box.dataset.live = 'true';
  btn.disabled = true;
  $('#brief-out').innerHTML = '<p class="err">Reading your unread items…</p>';
  try {
    const text = await ai.brief(input, (t) => { $('#brief-out').innerHTML = md(t); });
    const when = Date.now();
    await chrome.storage.local.set({ brief: { text, ids, when } });
    setBrief(text, ids, when);
  } catch (e) {
    $('#brief-out').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  } finally {
    box.dataset.live = 'false';
    btn.disabled = false;
  }
}

/* ---------- reader ---------- */
function setStatus(html) { $('#r-status').innerHTML = html || ''; }
function renderContent(html) { $('#r-content').innerHTML = html; }

async function openItem(id) {
  const it = S.items.find((x) => x.id === id) || (await db.get('items', id));
  if (!it) return;
  if (!S.feeds.has(it.feedId)) return;
  const f = S.feeds.get(it.feedId);
  speechSynthesis.cancel();
  setListen(false);
  S.cur = it;
  S.pane = 'article';
  S.chat = [];
  $('#r-chat').innerHTML = '';
  $('#r-q').value = '';
  if (!it.read) await setRead(it, true);

  const reader = $('#reader');
  reader.style.setProperty('--h', f.hue);
  reader.style.animation = 'none';
  void reader.offsetWidth;
  reader.style.animation = '';

  const site = siteOf(f);
  $('#r-src').innerHTML = site
    ? `<a class="src-link" href="${esc(site)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(feedName(f))} in a new tab">${esc(feedName(f))}${icon('external', 13)}</a>`
    : esc(feedName(f));
  $('#r-title').textContent = it.title;
  const mediaTag = it.media ? (it.media.type.startsWith('video') ? 'video' : 'audio') : '';
  const feedHtml =
    (it.image && !(it.html || '').includes(it.image) ? `<img src="${esc(it.image)}" alt="">` : '') +
    (it.media ? `<${mediaTag} src="${esc(it.media.url)}"></${mediaTag}>` : '') +
    (it.html || `<p>${esc(it.summary || '')}</p>`);
  S.feedText = textOf(it.html || it.summary);
  S.articleText = S.feedText;
  const words = S.feedText.split(/\s+/).filter(Boolean).length;
  $('#r-meta').innerHTML = [
    it.author ? `<span>${esc(it.author)}</span>` : '',
    `<span>${new Date(it.published).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}<span class="ago">, ${daysAgo(it.published)}</span></span>`,
    words > 80 ? `<span>${Math.max(1, Math.round(words / 220))} min read</span>` : '',
  ].join('');
  renderContent(sanitize(feedHtml, it.link));

  const open = $('#r-open');
  if (httpUrl(it.link)) open.href = it.link; else open.removeAttribute('href');
  syncReaderButtons();
  $('#r-sum-label').textContent = it.aiSummary ? 'Redo' : 'Summarize';
  $('#r-sum-out').innerHTML = it.aiSummary ? md(it.aiSummary) : '';
  setStatus('');
  $('#r-scroll').scrollTop = 0;
  setPaneOpen(true);
  renderPane();
  $$('.item.open').forEach((el) => el.classList.remove('open'));
  $(`.item[data-id="${CSS.escape(it.id)}"]`)?.classList.add('open');

  if (it.link) {
    if (words < 260) loadFull(it);
    else setStatus('<button type="button" id="r-full">Load the full article</button>');
  }
}

async function loadFull(it) {
  setStatus('Loading the full article…');
  try {
    const { text, url } = await fetchText(it.link);
    if (S.cur?.id !== it.id) return;
    const r = extract(text, url);
    if (r.text.length > S.feedText.length + 200) {
      S.articleText = r.text;
      renderContent(r.html);
      setStatus('');
    } else {
      setStatus('This is the complete text from the feed.');
    }
  } catch {
    if (S.cur?.id === it.id) setStatus('Showing the feed version. The full article could not be loaded.');
  }
}

function syncReaderButtons() {
  const it = S.cur;
  $('#r-star').setAttribute('aria-pressed', String(!!it?.starred));
  $('#r-star').setAttribute('aria-label', it?.starred ? 'Remove from saved' : 'Save');
  $('#r-star').title = it?.starred ? 'Remove from saved (s)' : 'Save (s)';
}

async function setSaved(it, on) {
  it.starred = on;
  if (S.cur?.id === it.id) S.cur.starred = on;
  await db.patchItems([it.id], { starred: on });
  refreshRow(it);
  syncReaderButtons();
  toast(on ? 'Saved. Saved articles are never deleted.' : 'Removed from saved');
}

async function setRead(it, read) {
  if (!!it.read === read) return;
  it.read = read;
  if (S.cur?.id === it.id) S.cur.read = read;
  await db.patchItems([it.id], { read });
  bump(it.feedId, read ? -1 : 1);
  refreshRow(it);
}

async function hideItem(it) {
  const wasRead = !!it.read;
  const idx = S.items.findIndex((x) => x.id === it.id);
  const reading = S.pane === 'article' && S.cur?.id === it.id;
  it.hidden = true;
  it.read = true;
  await db.patchItems([it.id], { hidden: true, read: true });
  if (!wasRead) bump(it.feedId, -1);
  const el = $(`.item[data-id="${CSS.escape(it.id)}"]`);
  el?.classList.add('leaving');
  toast('Hidden. It will not come back.', {
    label: 'Undo',
    run: async () => {
      await db.patchItems([it.id], { hidden: false, read: wasRead });
      if (!wasRead) bump(it.feedId, 1);
      await loadItems();
      render();
    },
  });
  setTimeout(() => {
    if (idx >= 0) S.items.splice(idx, 1);
    renderList();
    if (S.items.length) selectRow(Math.min(Math.max(idx, 0), S.items.length - 1), false);
    if (reading) {
      const next = S.items[idx];
      if (next) openItem(next.id); else closeReader();
    }
  }, el ? 200 : 0);
}

const toggleStar = async () => { if (S.cur) await setSaved(S.cur, !S.cur.starred); };

async function markUnread() {
  if (!S.cur) return;
  await setRead(S.cur, false);
  toast('Marked as unread');
  closeReader();
}

function closeReader() {
  speechSynthesis.cancel();
  setListen(false);
  const wasOpen = S.pane === 'article';
  S.pane = 'home';
  S.cur = null;
  setPaneOpen(false);
  renderPane();
  $$('.item.open').forEach((el) => el.classList.remove('open'));
  if (wasOpen) $(`.item[data-i="${S.sel}"]`)?.focus({ preventScroll: true });
}

async function summarizeCurrent() {
  const it = S.cur;
  if (!it) return;
  const box = $('#r-sum');
  const out = $('#r-sum-out');
  const btn = $('#r-sum-go');
  box.dataset.live = 'true';
  btn.disabled = true;
  out.innerHTML = '<p class="err">Reading the article…</p>';
  try {
    const text = await ai.summarize({ title: it.title, text: S.articleText || it.summary }, (t) => { if (S.cur?.id === it.id) out.innerHTML = md(t); });
    it.aiSummary = text;
    await db.patchItems([it.id], { aiSummary: text });
    if (S.cur?.id === it.id) $('#r-sum-label').textContent = 'Redo';
  } catch (e) {
    if (S.cur?.id === it.id) out.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  } finally {
    box.dataset.live = 'false';
    btn.disabled = false;
  }
}

async function askCurrent(question) {
  const it = S.cur;
  if (!it || !question.trim()) return;
  const chat = $('#r-chat');
  S.chat.push({ role: 'user', content: question });
  chat.insertAdjacentHTML('beforeend', `<div class="you">${esc(question)}</div><div class="bot"><p class="err">Thinking…</p></div>`);
  const bot = chat.lastElementChild;
  bot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    const reply = await ai.ask({ title: it.title, text: S.articleText || it.summary }, S.chat, (t) => { bot.innerHTML = md(t); });
    S.chat.push({ role: 'assistant', content: reply });
  } catch (e) {
    S.chat.pop();
    bot.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

function setListen(on) { $('#r-listen').setAttribute('aria-pressed', String(on)); }
function toggleListen() {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); setListen(false); return; }
  if (!S.cur) return;
  const text = `${S.cur.title}. ${S.articleText}`;
  const parts = text.match(/[^.!?\n]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > 240) { if (buf) chunks.push(buf); buf = p; } else buf += p;
  }
  if (buf) chunks.push(buf);
  const utterances = chunks.map((c) => new SpeechSynthesisUtterance(c));
  utterances.at(-1).onend = () => setListen(false);
  utterances.forEach((u) => speechSynthesis.speak(u));
  setListen(true);
}

async function markAllRead() {
  const unread = S.items.filter((i) => !i.read);
  if (!unread.length) { toast('Nothing to mark as read'); return; }
  if (unread.length > 20 && !confirm(`Mark ${unread.length} articles as read?`)) return;
  await db.patchItems(unread.map((i) => i.id), { read: true });
  unread.forEach((i) => { i.read = true; S.counts[i.feedId] = Math.max(0, (S.counts[i.feedId] || 0) - 1); });
  render();
  badge();
  toast(`Marked ${unread.length} as read`);
}

/* ---------- following ---------- */
const dlgAdd = $('#dlg-add');

function openAdd(prefill = '') {
  $('#add-input').value = prefill;
  $('#add-results').innerHTML = '';
  $('#add-msg').textContent = '';
  $('#add-follow').disabled = true;
  S.found = [];
  dlgAdd.showModal();
  $('#add-input').focus();
}

async function findFeeds() {
  const msg = $('#add-msg');
  const btn = $('#add-find');
  $('#add-results').innerHTML = '';
  $('#add-follow').disabled = true;
  msg.textContent = 'Looking for feeds…';
  btn.disabled = true;
  try {
    if (!(await ensureHosts())) throw new Error('Vangmayam needs permission to read the sites you follow. Choose Find feeds again and allow access.');
    S.found = await discover($('#add-input').value);
    const pagesOnly = S.found.every((r) => r.kind === 'page');
    msg.textContent = pagesOnly
      ? 'This site has no feed. Vangmayam can follow the page itself and pick up new articles as they appear.'
      : S.found.length > 1 ? 'Pick the ones you want.' : '';
    $('#add-results').innerHTML = S.found.map((r, i) => {
      const n = r.feed.items.length;
      const detail = r.kind === 'page' ? `${n} articles found on the page, no feed` : `${n} recent posts`;
      return `<li><label><input type="checkbox" value="${i}" ${i === 0 ? 'checked' : ''}><span><b>${esc(r.feed.title || hostOf(r.url))}</b><small>${detail}</small><small>${esc(r.url)}</small></span></label></li>`;
    }).join('');
    $('#add-follow').disabled = false;
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function followChecked() {
  const picks = $$('#add-results input:checked').map((i) => S.found[Number(i.value)]);
  if (!picks.length) return;
  const added = [];
  for (const r of picks) {
    const res = await followFeed(r);
    if (res.added) added.push(res.id);
  }
  dlgAdd.close();
  if (!added.length) { toast('You already follow that source'); return; }
  toast(added.length === 1 ? `Following ${picks[0].feed.title || 'source'}` : `Following ${added.length} sources`);
  await go('unread');
  await Promise.all(added.map(refreshFeedNow));
  await reload();
}

/* ---------- OPML ---------- */
async function importOpml(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'text/xml');
  const outlines = [...doc.querySelectorAll('outline[xmlUrl], outline[xmlurl]')];
  if (!outlines.length) { toast('No feeds found in that file'); return; }
  let added = 0;
  for (const o of outlines) {
    const url = o.getAttribute('xmlUrl') || o.getAttribute('xmlurl');
    if (!url) continue;
    const id = hash(url);
    if (await db.get('feeds', id)) continue;
    const title = o.getAttribute('title') || o.getAttribute('text') || hostOf(url);
    const p = o.parentElement;
    const folder = p && p.localName === 'outline' ? p.getAttribute('title') || p.getAttribute('text') || '' : '';
    await db.put('feeds', { id, url, title, siteUrl: o.getAttribute('htmlUrl') || '', hue: hueFor(title), folder, added: Date.now(), lastFetched: 0, error: null });
    added++;
  }
  toast(`Imported ${added} of ${outlines.length} sources`);
  await reload();
  await chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
  await reload();
}

function exportOpml() {
  const rows = [...S.feeds.values()].map((f) =>
    `    <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}" htmlUrl="${esc(f.siteUrl || '')}"/>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Vangmayam sources</title></head>\n  <body>\n${rows}\n  </body>\n</opml>\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], { type: 'text/x-opml' }));
  a.download = 'vangmayam-sources.opml';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- refresh ---------- */
async function refreshAll() {
  const btn = $('#btn-refresh');
  if (btn.classList.contains('spin')) return;
  if (!S.feeds.size) { openAdd(); return; }
  btn.classList.add('spin');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'refresh' });
    await reload();
    toast(r?.added ? `${r.added} new ${r.added === 1 ? 'post' : 'posts'}` : 'Up to date');
  } catch {
    toast('Could not refresh. Try again.');
  } finally {
    btn.classList.remove('spin');
  }
}

/* ---------- settings ---------- */
const dlgSettings = $('#dlg-settings');
const formSettings = $('#form-settings');
function syncProvider() {
  const p = formSettings.elements.provider.value;
  $$('[data-for]', formSettings).forEach((l) => { l.hidden = l.dataset.for !== p; });
}
async function openSettings() {
  const s = await getSettings();
  for (const k of Object.keys(DEFAULTS)) if (formSettings.elements[k]) formSettings.elements[k].value = s[k];
  $('#ollama-msg').textContent = '';
  syncProvider();
  dlgSettings.showModal();
}

/** Let the extension talk to the Ollama address that was typed in. */
async function allowOllama(url) {
  const u = new URL(url);
  const origins = [`${u.protocol}//${u.hostname}/*`];
  if (!(await chrome.permissions.contains({ origins }))) await chrome.permissions.request({ origins });
  await chrome.runtime.sendMessage({ type: 'ollama-rule', url });
}

async function detectOllama() {
  const msg = $('#ollama-msg');
  const url = formSettings.elements.ollamaUrl.value.trim() || DEFAULTS.ollamaUrl;
  msg.textContent = 'Looking for Ollama…';
  try {
    await allowOllama(url);
    const models = await ai.listOllamaModels(url);
    $('#ollama-models').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
    const field = formSettings.elements.ollamaModel;
    if (!models.length) msg.textContent = 'Ollama is running but has no models yet. Run: ollama pull llama3.2';
    else {
      if (!field.value || !models.includes(field.value)) field.value = models[0];
      msg.textContent = `Found ${models.length} ${models.length === 1 ? 'model' : 'models'}. Using ${field.value}.`;
    }
  } catch (e) {
    msg.textContent = e instanceof TypeError ? 'That address is not valid.' : e.message;
  }
}

/** Hide existing unsaved articles that mention a muted word. */
async function applyMutes(words) {
  if (!words.trim()) return 0;
  const match = mutedMatcher(words);
  const rows = await db.queryItems((it) => !it.hidden && !it.starred && match(`${it.title} ${it.summary}`), 100000);
  await db.patchItems(rows.map((r) => r.id), { hidden: true, read: true });
  return rows.length;
}

/* ---------- access banner ---------- */
async function checkAccess() {
  $('#banner').hidden = !S.feeds.size || (await hasHosts());
}
async function allowAndLoad() {
  if (!(await ensureHosts())) { toast('Vangmayam needs access to read your sources'); return; }
  await checkAccess();
  toast('Loading your sources…');
  refreshAll();
}

/* ---------- starter packs ---------- */
const dlgPacks = $('#dlg-packs');

function renderPacks() {
  const q = S.packsQ.trim().toLowerCase();
  const shown = PACKS.map((p) => {
    const packHit = q && p.name.toLowerCase().includes(q);
    const entries = p.feeds.filter((e) => !q || packHit || `${e.title} ${e.note || ''} ${hostOf(e.site)}`.toLowerCase().includes(q));
    return { p, entries };
  }).filter((x) => x.entries.length);
  if (!shown.length) { $('#packs-body').innerHTML = `<p class="hint">No source or pack matches “${esc(S.packsQ.trim())}”.</p>`; return; }
  $('#packs-body').innerHTML = shown.map(({ p, entries }) => {
    const ids = p.feeds.map(catalogId);
    const on = ids.filter((id) => S.feeds.has(id)).length;
    const rows = entries.map((e) => {
      const id = catalogId(e);
      const host = hostOf(e.site);
      return `<li><label class="pack-row" style="--h:${hueFor(e.title)}"><input type="checkbox" data-src="${esc(id)}" ${S.feeds.has(id) ? 'checked' : ''}>` +
        `<span class="bar-p"></span><span class="pack-text"><b>${esc(e.title)}</b><small>${esc(e.note || host)}</small></span></label></li>`;
    }).join('');
    return `<section class="pack"><header><div><h3>${esc(p.name)}</h3><p>${esc(p.blurb)}</p></div>` +
      `<div class="pack-actions"><span class="pack-n">${on} of ${ids.length}</span>` +
      `<button type="button" class="pill" data-pack-add="${esc(p.id)}">Add all</button>` +
      `<button type="button" class="ghost" data-pack-remove="${esc(p.id)}">Remove all</button></div></header><ul>${rows}</ul></section>`;
  }).join('');
}

async function afterPackChange() {
  await loadFeeds();
  if (S.feedId && !S.feeds.has(S.feedId)) { S.feedId = null; if (S.nav === 'feed') { S.nav = 'unread'; S.view = 'unread'; } }
  if (S.folder && ![...S.feeds.values()].some((f) => f.folder === S.folder)) { S.folder = null; if (S.nav === 'folder') { S.nav = 'unread'; S.view = 'unread'; } }
  if (S.cur && !S.feeds.has(S.cur.feedId)) closeReader();
  await loadItems();
  render();
  renderPacks();
  badge();
  checkAccess();
}

const loadSoon = () => chrome.runtime.sendMessage({ type: 'refresh' }).then(() => reload()).catch(() => {});

$('#packs-q').addEventListener('input', (e) => { S.packsQ = e.target.value; renderPacks(); });
$('#btn-packs').addEventListener('click', async () => {
  await loadFeeds();
  S.packsQ = '';
  $('#packs-q').value = '';
  renderPacks();
  dlgPacks.showModal();
});

$('#packs-body').addEventListener('change', async (e) => {
  const box = e.target.closest('[data-src]');
  if (!box) return;
  const id = box.dataset.src;
  if (box.checked) {
    await ensureHosts();
    if (await addCatalogSource(id)) { await afterPackChange(); loadSoon(); return; }
  } else {
    await db.deleteFeed(id);
  }
  await afterPackChange();
});

$('#packs-body').addEventListener('click', async (e) => {
  const addId = e.target.closest('[data-pack-add]')?.dataset.packAdd;
  const removeId = e.target.closest('[data-pack-remove]')?.dataset.packRemove;
  if (addId) {
    const pack = PACKS.find((p) => p.id === addId);
    await ensureHosts();
    let added = 0;
    for (const entry of pack.feeds) if (await addCatalogSource(catalogId(entry))) added++;
    await afterPackChange();
    if (added) { toast(`Added ${added} ${added === 1 ? 'source' : 'sources'}`); loadSoon(); }
  }
  if (removeId) {
    const pack = PACKS.find((p) => p.id === removeId);
    const ids = pack.feeds.map(catalogId).filter((id) => S.feeds.has(id));
    if (!ids.length) return;
    if (!confirm(`Remove ${ids.length} ${ids.length === 1 ? 'source' : 'sources'} from ${pack.name}? Their articles are deleted too.`)) return;
    for (const id of ids) await db.deleteFeed(id);
    await afterPackChange();
    toast('Removed');
  }
});

chrome.permissions.onAdded.addListener(checkAccess);
chrome.permissions.onRemoved.addListener(checkAccess);

/* ---------- events ---------- */
$('#btn-refresh').addEventListener('click', refreshAll);
$('#btn-add').addEventListener('click', () => openAdd());
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-menu').addEventListener('click', () => setRail(true));
$('#scrim').addEventListener('click', () => setRail(false));
$('#btn-readall').addEventListener('click', markAllRead);
$('#src-filter').addEventListener('input', (e) => { S.srcQ = e.target.value; renderRail(); });
$('#src-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.value) { e.target.value = ''; S.srcQ = ''; renderRail(); e.stopPropagation(); }
});

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav]');
  if (b) go(b.dataset.nav);
});
$('#sources').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    const f = S.feeds.get(del.dataset.del);
    if (f && confirm(`Unfollow ${feedName(f)}? Its articles, including saved ones, will be deleted.`)) {
      await db.deleteFeed(f.id);
      if (S.feedId === f.id) { S.feedId = null; S.nav = 'unread'; S.view = 'unread'; }
      if (S.cur?.feedId === f.id) closeReader();
      await reload();
      badge();
      toast('Unfollowed');
    }
    return;
  }
  const fold = e.target.closest('[data-fold]');
  if (fold) {
    const name = fold.dataset.fold;
    if (S.collapsed.has(name)) S.collapsed.delete(name); else S.collapsed.add(name);
    try { localStorage.setItem('raman.collapsed', JSON.stringify([...S.collapsed])); } catch { /* not saved */ }
    renderRail();
    return;
  }
  const folderBtn = e.target.closest('[data-folder]');
  if (folderBtn) { go('folder', null, folderBtn.dataset.folder); return; }
  const row = e.target.closest('[data-feed]');
  if (row) go('feed', row.dataset.feed);
});

let searchTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    S.q = e.target.value;
    if (S.nav === 'brief') { S.nav = 'unread'; }
    loadItems().then(render);
  }, 160);
});

$('#list').addEventListener('click', async (e) => {
  const row = e.target.closest('.item');
  if (!row) return;
  selectRow(Number(row.dataset.i), false);
  const action = e.target.closest('[data-row]')?.dataset.row;
  if (!action) { openItem(row.dataset.id); return; }
  const it = S.items.find((x) => x.id === row.dataset.id);
  if (!it) return;
  if (action === 'save') await setSaved(it, !it.starred);
  else if (action === 'read') await setRead(it, !it.read);
  else if (action === 'hide') await hideItem(it);
});
$('#list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('item')) openItem(e.target.dataset.id);
});
$('#list').addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add') openAdd();
  if (act === 'all') go('all');
  if (act === 'refresh') refreshAll();
  if (act === 'allow') allowAndLoad();
});

$('#brief-go').addEventListener('click', writeBrief);
$('#brief-out').addEventListener('click', (e) => {
  const n = e.target.closest('.cite')?.dataset.cite;
  const id = n && S.briefIds[Number(n) - 1];
  if (id) openItem(id);
});

$('#r-back').addEventListener('click', closeReader);
$('#r-star').addEventListener('click', toggleStar);
$('#r-unread').addEventListener('click', markUnread);
$('#r-hide').addEventListener('click', () => { if (S.cur) hideItem(S.cur); });
$('#t-rail').addEventListener('click', () => togglePane('hideRail'));
$('#t-list').addEventListener('click', () => togglePane('hideList'));
$('#t-focus').addEventListener('click', toggleFocus);
$('#t-measure').addEventListener('click', cycleMeasure);
$('#t-smaller').addEventListener('click', () => stepSize(-1));
$('#t-larger').addEventListener('click', () => stepSize(1));
$('#r-listen').addEventListener('click', toggleListen);
$('#r-sum-go').addEventListener('click', summarizeCurrent);
$('#r-status').addEventListener('click', (e) => { if (e.target.id === 'r-full' && S.cur) loadFull(S.cur); });
$('#r-ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#r-q').value;
  $('#r-q').value = '';
  askCurrent(q);
});

$('#form-add').addEventListener('submit', (e) => { e.preventDefault(); findFeeds(); });
$('#add-follow').addEventListener('click', followChecked);

formSettings.elements.provider.addEventListener('change', syncProvider);
formSettings.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) {
    const el = formSettings.elements[k];
    if (el) patch[k] = typeof DEFAULTS[k] === 'number' ? Number(el.value) : el.value.trim();
  }
  const before = await getSettings();
  if (patch.provider === 'ollama') { try { await allowOllama(patch.ollamaUrl || DEFAULTS.ollamaUrl); } catch { /* shown when AI is used */ } }
  await saveSettings(patch);
  dlgSettings.close();
  let hidden = 0;
  if (patch.mutedWords !== before.mutedWords) hidden = await applyMutes(patch.mutedWords);
  if (hidden || patch.retentionDays !== before.retentionDays) await reload();
  toast(hidden ? `Settings saved. Hid ${hidden} ${hidden === 1 ? 'article' : 'articles'}.` : 'Settings saved');
});
$('#ollama-detect').addEventListener('click', detectOllama);
$('#show-hidden').addEventListener('click', async () => {
  const rows = await db.queryItems((it) => it.hidden, 100000);
  await db.patchItems(rows.map((r) => r.id), { hidden: false });
  await reload();
  badge();
  toast(rows.length ? `${rows.length} hidden ${rows.length === 1 ? 'article is' : 'articles are'} visible again` : 'No hidden articles');
});
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('#opml-in').addEventListener('click', async () => { if (await ensureHosts()) $('#opml-file').click(); });
$('#opml-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importOpml(f); e.target.value = ''; });
$('#opml-out').addEventListener('click', () => (S.feeds.size ? exportOpml() : toast('Follow a source first')));

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const dialogOpen = !!document.querySelector('dialog[open]');
  if (e.key === 'Escape') {
    if (typing && e.target.id === 'q') { e.target.value = ''; S.q = ''; e.target.blur(); loadItems().then(render); return; }
    if (shell.dataset.rail === 'true') { setRail(false); return; }
    if (S.pane === 'article' && !dialogOpen) closeReader();
    return;
  }
  if (typing || dialogOpen) return;
  const reading = S.pane === 'article';
  switch (e.key) {
    case '/': e.preventDefault(); $('#q').focus(); break;
    case 'r': refreshAll(); break;
    case 'j': selectRow(S.sel + 1); if (reading && S.items[S.sel]) openItem(S.items[S.sel].id); break;
    case 'k': selectRow(S.sel - 1); if (reading && S.items[S.sel]) openItem(S.items[S.sel].id); break;
    case 'Enter':
    case 'o': if (!reading && S.items[S.sel]) openItem(S.items[S.sel].id); break;
    case 's': { const it = reading ? S.cur : S.items[S.sel]; if (it) setSaved(it, !it.starred); break; }
    case 'm': if (reading) markUnread(); else if (S.items[S.sel]) setRead(S.items[S.sel], !S.items[S.sel].read); break;
    case 'x': { const it = reading ? S.cur : S.items[S.sel]; if (it) hideItem(it); break; }
    case '[': if (reading) togglePane('hideRail'); break;
    case ']': if (reading) togglePane('hideList'); break;
    case 'f': if (reading) toggleFocus(); break;
    case '+': case '=': if (reading) stepSize(1); break;
    case '-': if (reading) stepSize(-1); break;
    default:
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'feeds-updated') reload();
});

/* #feed=ID lets the side panel jump straight to a source */
function applyHash() {
  const m = location.hash.match(/feed=([\w]+)/);
  if (m && S.feeds.has(m[1])) go('feed', m[1]);
}
window.addEventListener('hashchange', async () => { await loadFeeds(); applyHash(); });

/* ---------- boot ---------- */
(async function boot() {
  applyPrefs();
  await seedIfNeeded().catch(() => {});
  await reload();
  const { brief } = await chrome.storage.local.get('brief');
  if (brief && Date.now() - brief.when < 36e5 * 18) setBrief(brief.text, brief.ids, brief.when);
  applyHash();
  badge();
  if (S.feeds.size) chrome.runtime.sendMessage({ type: 'refresh' }).then(() => reload()).catch(() => {});
})();
