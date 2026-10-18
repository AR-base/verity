// Browser cache for embeddings, keyed by a hash of (model, text). Re-opening
// the page or rebuilding the index never pays twice for the same passage.
// Every call is wrapped: private windows and blocked storage simply mean
// "no cache", never an error.

const DB_NAME = 'verity';
const STORE = 'embeddings';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function hashKey(model, text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${model}\n${text}`)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getMany(keys) {
  const db = await openDb();
  if (!db) return keys.map(() => null);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const out = new Array(keys.length).fill(null);
      keys.forEach((k, i) => {
        const r = store.get(k);
        r.onsuccess = () => { out[i] = r.result instanceof Float32Array ? r.result : null; };
      });
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(keys.map(() => null));
    } catch {
      resolve(keys.map(() => null));
    }
  });
}

async function putMany(entries) {
  const db = await openDb();
  if (!db || !entries.length) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [k, v] of entries) store.put(Float32Array.from(v), k);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    } catch {
      resolve();
    }
  });
}

async function clearCache() {
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    } catch {
      resolve();
    }
  });
}

export { hashKey, getMany, putMany, clearCache };
