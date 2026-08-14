// IndexedDB wrapper. Everything lives on-device; no network required at runtime.

const DB_NAME = 'itinerary';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('trips')) {
        db.createObjectStore('trips', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('tripId', 'tripId');
      }
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: 'id' });
        s.createIndex('itemId', 'itemId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async all(store) {
    return tx(store, 'readonly', s => reqToPromise(s.getAll()));
  },
  async get(store, id) {
    return tx(store, 'readonly', s => reqToPromise(s.get(id)));
  },
  async put(store, value) {
    await tx(store, 'readwrite', s => s.put(value));
    return value;
  },
  async putMany(store, values) {
    await tx(store, 'readwrite', s => values.forEach(v => s.put(v)));
    return values;
  },
  async del(store, id) {
    await tx(store, 'readwrite', s => s.delete(id));
  },
  async byIndex(store, index, key) {
    return tx(store, 'readonly', s => reqToPromise(s.index(index).getAll(key)));
  },
  async clearAll() {
    for (const store of ['trips', 'items', 'files', 'meta']) {
      await tx(store, 'readwrite', s => s.clear());
    }
  },
  async metaGet(k, fallback = null) {
    const row = await this.get('meta', k);
    return row ? row.v : fallback;
  },
  async metaSet(k, v) {
    return this.put('meta', { k, v });
  },
};

export function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
