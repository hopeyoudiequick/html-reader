// Storage. Books go to IndexedDB because a volume can weigh several megabytes.
// The reading position and the settings are small, so they live in
// localStorage: its writes are synchronous, which matters when the app is
// being closed and an asynchronous write might never finish.

const DB_NAME = 'html-reader';
const DB_VERSION = 1;
const PROGRESS_KEY = 'html-reader:progress';
const SETTINGS_KEY = 'html-reader:settings';
const LAST_KEY = 'html-reader:last';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('books', { keyPath: 'id' });
        req.result.createObjectStore('chapters', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

// Runs one request in its own transaction and resolves with its result.
function request(storeName, mode, make) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = make(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transazione annullata'));
      })
  );
}

const chapterKey = (bookId, index) => `${bookId}/${index}`;

export function listBooks() {
  return request('books', 'readonly', (s) => s.getAll());
}

export function getBook(id) {
  return request('books', 'readonly', (s) => s.get(id));
}

export function getChapterHtml(bookId, index) {
  return request('chapters', 'readonly', (s) => s.get(chapterKey(bookId, index))).then((rec) =>
    rec ? rec.html : ''
  );
}

export function saveBook(meta, chapters) {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(['books', 'chapters'], 'readwrite');
        tx.objectStore('books').put(meta);
        const store = tx.objectStore('chapters');
        chapters.forEach((html, i) => store.put({ key: chapterKey(meta.id, i), html }));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('salvataggio non riuscito, spazio insufficiente?'));
      })
  );
}

export function deleteBook(id) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(['books', 'chapters'], 'readwrite');
        tx.objectStore('books').delete(id);
        tx.objectStore('chapters').delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or disabled: reading still works, the position is just not remembered.
  }
}

function readProgressMap() {
  const all = readJson(PROGRESS_KEY, {});
  return all && typeof all === 'object' ? all : {};
}

export function getProgress(bookId) {
  return readProgressMap()[bookId] || null;
}

export function setProgress(bookId, { chapter, offset, pct }) {
  const all = readProgressMap();
  all[bookId] = { chapter, offset, pct, at: Date.now() };
  writeJson(PROGRESS_KEY, all);
}

export function forgetProgress(bookId) {
  const all = readProgressMap();
  delete all[bookId];
  writeJson(PROGRESS_KEY, all);
}

// The book that was open when the app was last used, or null after "back to library".
export function getLastBookId() {
  return readJson(LAST_KEY, null);
}

export function setLastBookId(id) {
  writeJson(LAST_KEY, id);
}

export function getSettings() {
  const saved = readJson(SETTINGS_KEY, {});
  return saved && typeof saved === 'object' ? saved : {};
}

export function saveSettings(settings) {
  writeJson(SETTINGS_KEY, settings);
}
