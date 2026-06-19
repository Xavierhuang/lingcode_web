'use strict';

const DB_NAME = 'lingcode-projects';
const DB_VERSION = 1;
const STORE = 'projects';
const MAX_PROJECTS = 30;

let _db = null;

async function openDb() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const store = e.target.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('by_ts', 'timestamp', { unique: false });
    };
    req.onsuccess = (e) => {
      _db = e.target.result;
      _db.onclose = () => { _db = null; };
      _db.onerror = (ev) => { console.warn('[projects] DB error', ev.target.error); };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveProject(entry) {
  const db = await openDb();
  const count = await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const existing = await loadProject(entry.id).catch(() => null);
  if (!existing && count >= MAX_PROJECTS) {
    throw Object.assign(new Error('cap_reached'), { code: 'cap_reached', max: MAX_PROJECTS });
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function listProjects() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('by_ts').getAll();
    req.onsuccess = () => resolve((req.result || []).reverse());
    req.onerror = () => reject(req.error);
  });
}

export async function loadProject(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteProject(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
