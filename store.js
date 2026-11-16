// Page bodies can contain large HTML and offline image data. Keep them in
// IndexedDB so importing one page never rewrites the full library in storage.
(() => {
  const DB_NAME = 'sitedoc-library';
  const DB_VERSION = 1;
  const SCHEMA_VERSION = 2;
  let dbPromise;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  const bodyFields = ['html', 'text', 'headings', 'breadcrumbs', 'styles', 'siteTitle'];
  const hasBody = item => bodyFields.some(key => item[key] !== undefined);
  const bodyOf = item => Object.fromEntries(bodyFields.filter(key => key !== 'text' && item[key] !== undefined || key === 'text' && !item.html && item[key] !== undefined).map(key => [key, item[key]]));
  const metadataOf = item => {
    const copy = { ...item };
    for (const key of bodyFields) delete copy[key];
    return copy;
  };

  async function migrate() {
    const saved = await chrome.storage.local.get(['collections', 'collectionSchemaVersion']);
    if (saved.collectionSchemaVersion === SCHEMA_VERSION) return saved.collections || [];
    const collections = Array.isArray(saved.collections) ? saved.collections : [];
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('pages', 'readwrite');
      const pages = tx.objectStore('pages');
      for (const collection of collections) for (const item of collection.items || []) {
        if (item.kind !== 'section' && item.id && hasBody(item)) pages.put({ id: item.id, body: bodyOf(item) });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const metadata = collections.map(collection => ({ ...collection, items: (collection.items || []).map(metadataOf) }));
    await chrome.storage.local.set({ collections: metadata, collectionSchemaVersion: SCHEMA_VERSION });
    return metadata;
  }

  async function getCollections() { return migrate(); }

  async function getPage(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction('pages').objectStore('pages').get(id);
      request.onsuccess = () => resolve(request.result?.body || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function getFullCollections(collectionId) {
    const allCollections = await getCollections();
    const collections = collectionId ? allCollections.filter(collection => collection.id === collectionId) : allCollections;
    const ids = collections.flatMap(collection => collection.items.filter(item => item.kind !== 'section').map(item => item.id));
    const db = await openDb();
    const pages = await new Promise((resolve, reject) => {
      const tx = db.transaction('pages');
      const store = tx.objectStore('pages');
      const results = [];
      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => { if (request.result) results.push(request.result); };
        request.onerror = () => reject(request.error);
      }
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    });
    const bodies = new Map(pages.map(page => [page.id, page.body]));
    return collections.map(collection => ({ ...collection, items: collection.items.map(item => ({ ...item, ...(bodies.get(item.id) || {}) })) }));
  }

  async function saveCollections(collections) {
    const existing = await getCollections();
    const retained = new Set(collections.flatMap(collection => (collection.items || []).filter(item => item.kind !== 'section').map(item => item.id)));
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('pages', 'readwrite');
      const pages = tx.objectStore('pages');
      for (const collection of collections) for (const item of collection.items || []) {
        if (item.kind !== 'section' && item.id && hasBody(item)) {
          pages.put({ id: item.id, body: bodyOf(item) });
        }
      }
      for (const collection of existing) for (const item of collection.items || []) if (item.kind !== 'section' && !retained.has(item.id)) pages.delete(item.id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const metadata = collections.map(collection => ({ ...collection, items: (collection.items || []).map(metadataOf) }));
    await chrome.storage.local.set({ collections: metadata, collectionSchemaVersion: SCHEMA_VERSION });
    return metadata;
  }

  globalThis.SiteDocStore = { getCollections, getPage, getFullCollections, saveCollections };
})();
