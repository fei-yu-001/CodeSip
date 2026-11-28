import { cacheGeneration } from './session';
import { abortError } from './abort';
let dbPromise: Promise<IDBDatabase> | undefined;
export function cacheDatabase() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('codesip-reader', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = undefined;
      reject(req.error);
    };
  }));
}
export async function cacheAccess<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const generation = cacheGeneration();
  const database = await cacheDatabase();
  if (mode === 'readwrite' && generation !== cacheGeneration()) throw abortError();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('cache', mode);
    const req = operation(tx.objectStore('cache'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const cached = <T>(key: string) => cacheAccess<T | undefined>('readonly', (s) => s.get(key));
export const save = (key: string, value: unknown) =>
  cacheAccess('readwrite', (s) => s.put(value, key));
export const remove = (key: string) => cacheAccess('readwrite', (s) => s.delete(key));
