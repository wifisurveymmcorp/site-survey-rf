// Persistência local (IndexedDB) para não perder a sessão se a página recarregar no campo.
const DB = 'survey', STORE = 'kv';

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function save(key, value) {
  try {
    const d = await db();
    await new Promise((res, rej) => { const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(value, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch (e) { console.warn('save falhou', e); }
}

export async function load(key) {
  try {
    const d = await db();
    return await new Promise((res, rej) => { const r = d.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  } catch (e) { console.warn('load falhou', e); return undefined; }
}
