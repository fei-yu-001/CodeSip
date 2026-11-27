import type { User, Manifest, Library, FileEntry } from '../../shared/types';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(init.body instanceof FormData ? 180000 : 20000);
  const response = await fetch('/api' + url, {
    credentials: 'same-origin',
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: '请求失败' }));
    throw new HttpError(response.status, body.error);
  }
  return response.json();
}
let dbPromise: Promise<IDBDatabase> | undefined;
function db() {
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
async function access<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const generation = privateGeneration;
  const database = await db();
  if (mode === 'readwrite' && generation !== privateGeneration) throw abortError();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('cache', mode);
    const req = operation(tx.objectStore('cache'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const cached = <T>(key: string) => access<T | undefined>('readonly', (s) => s.get(key));
export const save = (key: string, value: unknown) => access('readwrite', (s) => s.put(value, key));
export const remove = (key: string) => access('readwrite', (s) => s.delete(key));
let privateGeneration = 0;
export const cacheGeneration = () => privateGeneration;
const privateDataCleaners = new Set<() => void>();
export function onPrivateDataCleared(cleaner: () => void): () => void {
  privateDataCleaners.add(cleaner);
  return () => privateDataCleaners.delete(cleaner);
}
export async function clearPrivateData(keepAnnotations = false) {
  privateGeneration++;
  for (const cleaner of privateDataCleaners) {
    try {
      cleaner();
    } catch {
      /* Cleanup listeners isolate private state across test and browser runs. */
    }
  }
  try {
    window.dispatchEvent(new Event('codesip:private-data-cleared'));
  } catch {
    /* ignore in non-window test environments */
  }
  await access('readwrite', (s) => s.clear());
  for (const key of Object.keys(localStorage))
    if (key.startsWith('codesip:')) {
      if (
        keepAnnotations &&
        (key.startsWith('codesip:annotations:') || key.startsWith('codesip:document:'))
      )
        continue;
      localStorage.removeItem(key);
    }
}
export const manifestKey = (user: User, id: string) => `${user.id}:manifest:${id}`;
const blobKey = (user: User, id: string, hash: string) => `${user.id}:blob:${id}:${hash}`;
function abortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
export async function fileBlob(
  user: User,
  id: string,
  entry: FileEntry,
  network = true,
  signal?: AbortSignal,
  requireStorage = false,
): Promise<Blob> {
  if (signal?.aborted) throw abortError(signal);
  const generation = privateGeneration;
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
  if (generation !== privateGeneration) throw abortError(signal);
  const blob = new Blob([bytes], { type: entry.mediaType });
  try {
    await save(blobKey(user, id, entry.hash), blob);
  } catch {
    if (requireStorage) throw new Error('本机存储空间不足，文件未能保存；已有存档保留');
    window.dispatchEvent(new Event('codesip:cache-write-failed'));
  }
  if (generation !== privateGeneration || signal?.aborted) throw abortError(signal);
  return blob;
}
export async function downloadLibrary(
  user: User,
  manifest: Manifest,
  progress: (done: number, total: number) => void,
  signal?: AbortSignal,
  scope: 'all' | 'saved' = 'all',
) {
  const generation = privateGeneration;
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
      const keys = await access<IDBValidKey[]>('readonly', (store) =>
        store.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')),
      );
      const hashes = new Set(keys.map((key) => String(key).slice(prefix.length)));
      const oldHashes = new Map(previous?.files.map((file) => [file.path, file.hash]));
      files = manifest.files.filter(
        (file) => hashes.has(file.hash) || hashes.has(oldHashes.get(file.path) || ''),
      );
    }
  }
  if (signal?.aborted || generation !== privateGeneration) throw abortError(signal);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let cursor = 0,
    done = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, async () => {
      try {
        while (cursor < files.length) {
          if (combined.aborted || generation !== privateGeneration) throw abortError(combined);
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
  if (combined.aborted || generation !== privateGeneration) throw abortError(combined);
  await save(manifestKey(user, manifest.library.id), manifest);
  if (combined.aborted || generation !== privateGeneration) throw abortError(combined);
  if (files.length === manifest.files.length)
    await save(`${user.id}:offline:${manifest.library.id}`, {
      revision: manifest.library.revision,
      date: new Date().toISOString(),
    });
}
// Publish a successful deletion and its local directory in one transaction.
// Blobs are keyed by hash: identical files must keep their shared cached bytes.
export async function cacheFileRemoval(user: User, manifest: Manifest) {
  const generation = privateGeneration;
  const database = await db();
  if (generation !== privateGeneration) throw abortError();
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
  const generation = privateGeneration;
  const database = await db();
  if (generation !== privateGeneration) throw abortError();
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
export const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;
export const relativeDate = (date: string) => {
  const diff = Date.now() - Date.parse(date);
  return diff < 60000
    ? '刚刚更新'
    : diff < 3600000
      ? `${Math.floor(diff / 60000)} 分钟前`
      : diff < 86400000
        ? `${Math.floor(diff / 3600000)} 小时前`
        : new Date(date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
};
export const cachedLibraries = (user: User) => cached<Library[]>(`${user.id}:libraries`);
