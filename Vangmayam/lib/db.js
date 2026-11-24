// The database keeps its original name so libraries made before the rename still open.
const NAME = 'fathom';
const VERSION = 2; // v2: item ids are `${feedId}:${hash}` (see lib/ingest.js)
let dbp;

function open() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = (ev) => {
      const d = r.result;
      if (ev.oldVersion < 1) {
        d.createObjectStore('feeds', { keyPath: 'id' });
        const items = d.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('published', 'published');
        items.createIndex('feedId', 'feedId');
      }
      if (ev.oldVersion >= 1 && ev.oldVersion < 2) {
        // Item ids gained their feed id as a prefix. Re-key every row in place so nothing
        // is downloaded again or shown as unread. Rows that already carry a prefix are skipped.
        const items = r.transaction.objectStore('items');
        items.openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return;
          const v = c.value;
          if (!String(v.id).includes(':')) {
            c.delete();
            items.put({ ...v, id: `${v.feedId}:${v.id}` });
          }
          c.continue();
        };
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

const wrap = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const store = async (n, mode = 'readonly') => (await open()).transaction(n, mode).objectStore(n);

export const all = async (n) => wrap((await store(n)).getAll());
export const get = async (n, id) => wrap((await store(n)).get(id));
export const put = async (n, v) => wrap((await store(n, 'readwrite')).put(v));
export const del = async (n, id) => wrap((await store(n, 'readwrite')).delete(id));

export async function putMany(n, vals) {
  if (!vals.length) return;
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(n, 'readwrite');
    const s = t.objectStore(n);
    vals.forEach((v) => s.put(v));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function itemIdsForFeed(feedId) {
  return wrap((await store('items')).index('feedId').getAllKeys(feedId));
}

/** Newest first. Walks the published index and keeps rows that pass `pred`. */
export async function queryItems(pred, limit = 300) {
  const db = await open();
  return new Promise((res, rej) => {
    const out = [];
    const r = db.transaction('items').objectStore('items').index('published').openCursor(null, 'prev');
    r.onsuccess = () => {
      const c = r.result;
      if (!c || out.length >= limit) return res(out);
      if (pred(c.value)) out.push(c.value);
      c.continue();
    };
    r.onerror = () => rej(r.error);
  });
}

export async function unreadCounts() {
  const db = await open();
  return new Promise((res, rej) => {
    const out = {};
    const r = db.transaction('items').objectStore('items').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res(out);
      if (!c.value.read && !c.value.hidden) out[c.value.feedId] = (out[c.value.feedId] || 0) + 1;
      c.continue();
    };
    r.onerror = () => rej(r.error);
  });
}

export async function unreadTotal() {
  return Object.values(await unreadCounts()).reduce((a, b) => a + b, 0);
}

export async function patchItems(ids, patch) {
  if (!ids.length) return;
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction('items', 'readwrite');
    const s = t.objectStore('items');
    ids.forEach((id) => {
      const g = s.get(id);
      g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...patch }); };
    });
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export async function deleteFeed(id) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(['feeds', 'items'], 'readwrite');
    t.objectStore('feeds').delete(id);
    const items = t.objectStore('items');
    const r = items.index('feedId').openKeyCursor(IDBKeyRange.only(id));
    r.onsuccess = () => {
      const c = r.result;
      if (c) { items.delete(c.primaryKey); c.continue(); }
    };
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export async function prune(days) {
  if (!(days > 0)) return; // 0 means keep everything
  const db = await open();
  const cutoff = Date.now() - days * 864e5;
  return new Promise((res, rej) => {
    const t = db.transaction('items', 'readwrite');
    const r = t.objectStore('items').index('published').openCursor(IDBKeyRange.upperBound(cutoff));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return;
      if (!c.value.starred) c.delete(); // saved articles are never pruned
      c.continue();
    };
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
