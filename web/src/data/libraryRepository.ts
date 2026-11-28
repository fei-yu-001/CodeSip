import type { User, Manifest, Library, FileEntry } from '../../../shared/types';
import { HttpError } from './http';
import { cacheGeneration } from './session';
import { cached, save, cacheAccess, cacheDatabase } from './localCache';
import { abortError } from './abort';
export const manifestKey = (user: User, id: string) => `${user.id}:manifest:${id}`;
const blobKey = (user: User, id: string, hash: string) => `${user.id}:blob:${id}:${hash}`;
export async function fileBlob(
  user: User,
  id: string,
  entry: FileEntry,
  network = true,
  signal?: AbortSignal,
  requireStorage = false,
): Promise<Blob> {
  if (signal?.aborted) throw abortError(signal);
  const generation = cacheGeneration();
  const hit = await cached<Blob>(blobKey(user, id, entry.hash)).catch(() => undefined);
  if (signal?.aborted) throw abortError(signal);
  if (hit) return hit;
  if (!network) throw new Error('这份文件尚未保存离线副本，请联网后打开');
  const response = await fetch(
    `/api/libraries/${id}/file?path=${encodeURIComponent(entry.path)}&hash=${entry.hash}`,
    {
      credentials: 'same-origin',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
        : AbortSignal.timeout(45000),
    },
  );
  if (!response.ok)
    throw new HttpError(
      response.status,
      (await response.json().catch(() => ({ error: '文件读取失败' }))).error,
    );
  const bytes = await response.arrayBuffer();
  if (signal?.aborted) throw abortError(signal);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (signal?.aborted) throw abortError(signal);
  if (hash !== entry.hash) throw new Error('文件刚刚更新，请同步后重试');
  if (generation !== cacheGeneration()) throw abortError(signal);
  const blob = new Blob([bytes], { type: entry.mediaType });
  try {
    await save(blobKey(user, id, entry.hash), blob);
  } catch {
    if (requireStorage) throw new Error('本机存储空间不足，文件未能保存；已有存档保留');
    window.dispatchEvent(new Event('codesip:cache-write-failed'));
  }
  if (generation !== cacheGeneration() || signal?.aborted) throw abortError(signal);
  return blob;
}
export async function downloadLibrary(
  user: User,
  manifest: Manifest,
  progress: (done: number, total: number) => void,
  signal?: AbortSignal,
  scope: 'all' | 'saved' = 'all',
) {
  const generation = cacheGeneration();
  let files = manifest.files;
  if (scope === 'saved') {
    const [previous, offline] = await Promise.all([
      cached<Manifest>(manifestKey(user, manifest.library.id)),
      cached<{ revision: number }>(`${user.id}:offline:${manifest.library.id}`),
    ]);
    // A deliberately saved full archive stays complete across revisions.
    // Ordinary sync updates only files already read or saved on this device.
    if (!previous || offline?.revision !== previous.library.revision) {
      const prefix = `${user.id}:blob:${manifest.library.id}:`;
      const keys = await cacheAccess<IDBValidKey[]>('readonly', (store) =>
        store.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')),
      );
      const hashes = new Set(keys.map((key) => String(key).slice(prefix.length)));
      const oldHashes = new Map(previous?.files.map((file) => [file.path, file.hash]));
      files = manifest.files.filter(
        (file) => hashes.has(file.hash) || hashes.has(oldHashes.get(file.path) || ''),
      );
    }
  }
  if (signal?.aborted || generation !== cacheGeneration()) throw abortError(signal);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let cursor = 0,
    done = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, async () => {
      try {
        while (cursor < files.length) {
          if (combined.aborted || generation !== cacheGeneration()) throw abortError(combined);
          const file = files[cursor++];
          await fileBlob(user, manifest.library.id, file, true, combined, true);
          progress(++done, files.length);
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) throw controller.signal.reason ?? failed.reason;
  if (combined.aborted || generation !== cacheGeneration()) throw abortError(combined);
  await save(manifestKey(user, manifest.library.id), manifest);
  if (combined.aborted || generation !== cacheGeneration()) throw abortError(combined);
  if (files.length === manifest.files.length)
    await save(`${user.id}:offline:${manifest.library.id}`, {
      revision: manifest.library.revision,
      date: new Date().toISOString(),
    });
}
// Publish a successful deletion and its local directory in one transaction.
// Blobs are keyed by hash: identical files must keep their shared cached bytes.
export async function cacheFileRemoval(user: User, manifest: Manifest) {
  const generation = cacheGeneration();
  const database = await cacheDatabase();
  if (generation !== cacheGeneration()) throw abortError();
  const id = manifest.library.id;
  const keep = new Set(manifest.files.map((file) => blobKey(user, id, file.hash)));
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('cache', 'readwrite');
    const store = tx.objectStore('cache');
    const prefix = `${user.id}:blob:${id}:`;
    const keys = store.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    keys.onsuccess = () => {
      const available = new Set(keys.result.map(String));
      for (const key of available) if (!keep.has(key)) store.delete(key);
      if ([...keep].every((key) => available.has(key)))
        store.put(
          { revision: manifest.library.revision, date: new Date().toISOString() },
          `${user.id}:offline:${id}`,
        );
      else store.delete(`${user.id}:offline:${id}`);
    };
    store.put(manifest, manifestKey(user, id));
    const libraries = store.get(`${user.id}:libraries`);
    libraries.onsuccess = () => {
      if (Array.isArray(libraries.result))
        store.put(
          (libraries.result as Library[]).map((library) =>
            library.id === id ? manifest.library : library,
          ),
          `${user.id}:libraries`,
        );
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function removeLibraryCache(user: User, id: string) {
  const generation = cacheGeneration();
  const database = await cacheDatabase();
  if (generation !== cacheGeneration()) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('cache', 'readwrite');
    const store = tx.objectStore('cache');
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      const key = String(item.key);
      if (
        key === manifestKey(user, id) ||
        key === `${user.id}:offline:${id}` ||
        key.startsWith(`${user.id}:blob:${id}:`)
      )
        item.delete();
      item.continue();
    };
    const libraries = store.get(`${user.id}:libraries`);
    libraries.onsuccess = () => {
      if (Array.isArray(libraries.result))
        store.put(
          (libraries.result as Library[]).filter((library) => library.id !== id),
          `${user.id}:libraries`,
        );
    };
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export const cachedLibraries = (user: User) => cached<Library[]>(`${user.id}:libraries`);
