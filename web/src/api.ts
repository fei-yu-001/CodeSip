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
  const response = await fetch('/api' + url, {
    credentials: 'same-origin',
    ...init,
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
    req.onerror = () => reject(req.error);
  }));
}
async function access<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const database = await db();
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
export async function clearPrivateData(keepAnnotations = false) {
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
export async function fileBlob(
  user: User,
  id: string,
  entry: FileEntry,
  network = true,
): Promise<Blob> {
  const hit = await cached<Blob>(blobKey(user, id, entry.hash));
  if (hit) return hit;
  if (!network) throw new Error('这份文件尚未保存离线副本，请联网后打开');
  const response = await fetch(
    `/api/libraries/${id}/file?path=${encodeURIComponent(entry.path)}&hash=${entry.hash}`,
    { credentials: 'same-origin' },
  );
  if (!response.ok)
    throw new HttpError(
      response.status,
      (await response.json().catch(() => ({ error: '文件读取失败' }))).error,
    );
  const bytes = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== entry.hash) throw new Error('文件刚刚更新，请刷新项目后重试');
  return new Blob([bytes], { type: entry.mediaType });
}
export async function downloadLibrary(
  user: User,
  manifest: Manifest,
  progress: (done: number, total: number) => void,
) {
  for (let i = 0; i < manifest.files.length; i++) {
    const file = manifest.files[i];
    const blob = await fileBlob(user, manifest.library.id, file);
    await save(blobKey(user, manifest.library.id, file.hash), blob);
    progress(i + 1, manifest.files.length);
  }
  await save(manifestKey(user, manifest.library.id), manifest);
  await save(`${user.id}:offline:${manifest.library.id}`, {
    revision: manifest.library.revision,
    date: new Date().toISOString(),
  });
}
export async function removeLibraryCache(user: User, id: string) {
  const database = await db();
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
