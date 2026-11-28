import { api, HttpError } from './data/http';
import type { ReaderAnnotation } from '../../shared/types';
import {
  readerKey,
  readerIdentities,
  wasReaderLoaded,
  type ReaderIdentity,
} from './readerIdentity';

export type AnnotationSyncStatus = 'synced' | 'pending' | 'conflict' | 'deleting';
export interface Annotation {
  id: string;
  line: number;
  snippet: string;
  note: string;
  createdAt: number;
  updatedAt?: number;
  localRev?: number;
  syncStatus?: AnnotationSyncStatus;
  lastError?: string;
  pendingDelete?: boolean;
  attempted?: boolean;
}
export function parseAnnotations(value: string | null): Annotation[] {
  if (!value) return [];
  const items: unknown = JSON.parse(value);
  if (
    !Array.isArray(items) ||
    !items.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        Number.isSafeInteger(item.line) &&
        item.line >= 1 &&
        typeof item.snippet === 'string' &&
        typeof item.note === 'string' &&
        Number.isFinite(item.createdAt) &&
        (item.updatedAt === undefined ||
          (Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0)) &&
        (item.localRev === undefined || Number.isSafeInteger(item.localRev)) &&
        (item.syncStatus === undefined ||
          ['synced', 'pending', 'conflict', 'deleting'].includes(item.syncStatus)) &&
        (item.pendingDelete === undefined || typeof item.pendingDelete === 'boolean') &&
        (item.attempted === undefined || typeof item.attempted === 'boolean'),
    )
  )
    throw new Error('本机批注读取失败，暂不能覆盖保存');
  return items.map((item) => ({
    ...item,
    localRev: item.localRev ?? 1,
    syncStatus: item.syncStatus ?? (item.updatedAt ? 'synced' : 'pending'),
  }));
}
const sameContent = (a: Annotation, b: ReaderAnnotation) =>
  a.line === b.line && a.snippet === b.snippet && a.note.trim() === b.note;
const fromRemote = (item: ReaderAnnotation, localRev = 1): Annotation => ({
  id: item.id,
  line: item.line,
  snippet: item.snippet,
  note: item.note,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  localRev,
  syncStatus: 'synced',
});
const errorMessage = (error: unknown) =>
  error instanceof HttpError ? error.message : '未能连接服务，草稿保留在本机';

// A file has one queue, including reads, writes and explicit conflict resolution.
// It survives reader navigation; logout invalidates it before private data is cleared.
class AnnotationStore {
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private requestController?: AbortController;
  private state: { annotations: Annotation[]; error: string };
  notify: (message: string) => void;
  constructor(
    private key: string,
    private identity: ReaderIdentity,
    notify: (message: string) => void,
  ) {
    this.notify = notify;
    try {
      this.state = { annotations: parseAnnotations(localStorage.getItem(key)), error: '' };
    } catch {
      this.state = { annotations: [], error: '本机批注读取失败，暂不能覆盖保存' };
    }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispose() {
    this.disposed = true;
    this.requestController?.abort();
    this.listeners.clear();
  }
  private get base() {
    return `/libraries/${encodeURIComponent(this.identity.libraryId)}/annotations`;
  }
  private async request<T>(url: string, init: RequestInit = {}) {
    const controller = new AbortController();
    this.requestController = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      return await api<T>(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (this.requestController === controller) this.requestController = undefined;
    }
  }
  private enqueue<T>(task: () => Promise<T>, cancelled: T): Promise<T> {
    const result = this.tail.then(() => (this.disposed || this.state.error ? cancelled : task()));
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private commit(annotations: Annotation[], failure = '批注未能保存，请检查本机存储空间后重试') {
    if (this.disposed) return false;
    if (this.state.error) {
      this.notify(this.state.error);
      return false;
    }
    const sorted = [...annotations].sort((a, b) => a.line - b.line || a.createdAt - b.createdAt);
    try {
      localStorage.setItem(this.key, JSON.stringify(sorted));
    } catch {
      this.notify(failure);
      return false;
    }
    this.state = { annotations: sorted, error: '' };
    this.listeners.forEach((listener) => listener());
    return true;
  }
  private update(id: string, transform: (item: Annotation) => Annotation | null, failure?: string) {
    return this.commit(
      this.state.annotations.flatMap((item) => {
        if (item.id !== id) return [item];
        const next = transform(item);
        return next ? [next] : [];
      }),
      failure,
    );
  }
  private async remote(signal?: AbortSignal) {
    const result = await this.request<{ annotations: ReaderAnnotation[] }>(
      `${this.base}?path=${encodeURIComponent(this.identity.path)}`,
      { signal },
    );
    return result.annotations;
  }
  private async readRemote() {
    const records = await this.remote();
    this.mergeRemote(records);
  }
  mergeRemote(records: ReaderAnnotation[]) {
    if (this.disposed) return;
    const remote = new Map(records.map((item) => [item.id, item]));
    const merged: Annotation[] = [];
    for (const item of this.state.annotations) {
      const other = remote.get(item.id);
      remote.delete(item.id);
      if (item.syncStatus === 'synced') {
        if (other) merged.push(fromRemote(other, item.localRev));
      } else if (item.syncStatus === 'pending' && other && sameContent(item, other)) {
        // Also recovers a successful write whose HTTP response was lost.
        merged.push(fromRemote(other, item.localRev));
      } else if (
        item.syncStatus === 'pending' &&
        ((other && other.updatedAt !== item.updatedAt) || (!other && item.updatedAt !== undefined))
      ) {
        merged.push({
          ...item,
          syncStatus: 'conflict',
          lastError: '服务器版本已改变，请选择要保留的版本',
        });
      } else {
        // Pending deletions and conflicts retain their original intent and content.
        merged.push(item);
      }
    }
    for (const item of remote.values()) merged.push(fromRemote(item));
    if (!this.commit(merged, '服务器已读取，但本机缓存未能更新'))
      throw new Error('批注未能存入本机');
    localStorage.setItem(readerKey('annotations-loaded', this.identity), '1');
  }
  persist = (
    items: Annotation[],
    action?: { type: 'save' | 'delete'; item: Annotation },
  ): boolean => {
    if (!action) {
      const saved = this.commit(items);
      if (saved) this.notify('批注已保存到本机');
      return saved;
    }
    const previous = this.state.annotations.find((item) => item.id === action.item.id);
    const next: Annotation = {
      ...action.item,
      updatedAt: action.item.updatedAt,
      localRev: (previous?.localRev ?? 0) + 1,
      attempted: previous?.attempted || previous?.updatedAt !== undefined || false,
      syncStatus: action.type === 'delete' ? 'deleting' : 'pending',
      pendingDelete: action.type === 'delete',
      lastError: undefined,
    };
    if (action.type === 'delete' && next.updatedAt === undefined && !next.attempted) {
      const saved = this.commit(this.state.annotations.filter((item) => item.id !== next.id));
      if (saved) this.notify('本机草稿已删除');
      return saved;
    }
    // Use the current store, not the render's array captured before another response.
    if (!this.commit([...this.state.annotations.filter((item) => item.id !== next.id), next]))
      return false;
    this.notify(
      action.type === 'delete' ? '删除请求已保留，等待同步' : '批注已保存到本机，等待同步',
    );
    return true;
  };
  sync = (signal?: AbortSignal) => this.enqueue(() => this.flush(signal), undefined);
  loadOnce = () => {
    if (wasReaderLoaded('annotations', this.identity)) return Promise.resolve();
    return this.enqueue(async () => {
      try {
        await this.readRemote();
      } catch {
        /* First read can be retried by explicit sync. */
      }
    }, undefined);
  };
  reload = () => {
    return this.enqueue(async () => {
      try {
        await this.readRemote();
      } catch {
        /* Keep local data when offline or signed out. */
      }
      await this.flush();
    }, undefined);
  };
  private async flush(signal?: AbortSignal) {
    signal?.throwIfAborted();
    // This queue is entered explicitly. A WebView connectivity hint must not
    // discard the user's Sync action; failed requests retain the local record.
    if (this.disposed) return;
    const ids = this.state.annotations
      .filter((item) => item.syncStatus === 'pending' || item.syncStatus === 'deleting')
      .map((item) => item.id);
    for (const id of ids) {
      signal?.throwIfAborted();
      if (this.disposed) return;
      const item = this.state.annotations.find((value) => value.id === id);
      if (!item || (item.syncStatus !== 'pending' && item.syncStatus !== 'deleting')) continue;
      if (item.syncStatus === 'deleting') await this.deleteRemote(item, signal);
      else await this.saveRemote(item, signal);
      signal?.throwIfAborted();
    }
  }
  private failed(item: Annotation, error: unknown) {
    if (this.disposed) return;
    this.update(item.id, (current) =>
      current.localRev !== item.localRev
        ? current
        : {
            ...current,
            syncStatus:
              error instanceof HttpError && error.status === 409 ? 'conflict' : current.syncStatus,
            lastError: errorMessage(error),
          },
    );
    this.notify(errorMessage(error));
  }
  private async saveRemote(item: Annotation, signal?: AbortSignal) {
    // Persist the uncertain-write marker before sending, including for a new draft.
    if (!this.update(item.id, (current) => ({ ...current, attempted: true }))) return;
    try {
      const result = await this.request<{ annotation: ReaderAnnotation }>(
        `${this.base}/${encodeURIComponent(item.id)}`,
        {
          method: 'PUT',
          signal,
          body: JSON.stringify({
            path: this.identity.path,
            line: item.line,
            snippet: item.snippet,
            note: item.note,
            expectedUpdatedAt: item.updatedAt ?? null,
          }),
        },
      );
      if (this.disposed) return;
      const current = this.state.annotations.find((value) => value.id === item.id);
      const stillCurrent =
        !!current && current.localRev === item.localRev && current.syncStatus === 'pending';
      const saved = this.update(
        item.id,
        (latest) =>
          latest.localRev === item.localRev
            ? fromRemote(result.annotation, latest.localRev)
            : { ...latest, updatedAt: result.annotation.updatedAt },
        '服务器已保存，但本机状态未能更新，请刷新确认',
      );
      if (saved && stillCurrent) this.notify('批注已同步');
    } catch (error) {
      signal?.throwIfAborted();
      this.failed(item, error);
      if (signal && error instanceof HttpError && error.status === 401) throw error;
    }
  }
  private async deleteRemote(item: Annotation, signal?: AbortSignal) {
    try {
      let version = item.updatedAt;
      if (version === undefined && item.attempted) {
        const remote = (await this.remote(signal)).find((value) => value.id === item.id);
        if (this.disposed) return;
        if (remote && !sameContent(item, remote))
          throw new HttpError(409, '服务器存在不同版本，请确认删除');
        version = remote?.updatedAt;
      }
      if (version !== undefined)
        await this.request(`${this.base}/${encodeURIComponent(item.id)}`, {
          method: 'DELETE',
          signal,
          body: JSON.stringify({ expectedUpdatedAt: version }),
        });
      if (this.disposed) return;
      const saved = this.update(
        item.id,
        (current) =>
          current.localRev === item.localRev
            ? null
            : {
                ...current,
                syncStatus: 'conflict',
                lastError: '服务器版本已删除，可保留本机内容为新批注',
              },
        '删除已提交，但本机状态未能更新，请刷新确认',
      );
      if (saved) this.notify(version === undefined ? '本机草稿已删除' : '批注已删除');
    } catch (error) {
      signal?.throwIfAborted();
      this.failed(item, error);
      if (signal && error instanceof HttpError && error.status === 401) throw error;
    }
  }
  resolveConflict = (id: string, choice: 'local' | 'remote'): Promise<boolean> =>
    this.enqueue(async () => {
      const item = this.state.annotations.find((value) => value.id === id);
      if (!item) return false;
      try {
        const other = (await this.remote()).find((value) => value.id === id);
        if (this.disposed) return false;
        if (this.state.annotations.find((value) => value.id === id)?.localRev !== item.localRev) {
          this.notify('本机草稿已改变，请重新确认');
          return false;
        }
        if (choice === 'remote') {
          const saved = this.update(id, () =>
            other ? fromRemote(other, (item.localRev ?? 0) + 1) : null,
          );
          if (saved) this.notify(other ? '已采用服务器版本' : '已确认服务器删除');
          return saved;
        }
        if (item.pendingDelete && !other) return this.update(id, () => null);
        const next: Annotation = {
          ...item,
          id: other ? id : crypto.randomUUID(),
          updatedAt: other?.updatedAt,
          localRev: (item.localRev ?? 0) + 1,
          attempted: !!other,
          syncStatus: item.pendingDelete ? 'deleting' : 'pending',
          lastError: undefined,
        };
        const saved = this.commit([
          ...this.state.annotations.filter((value) => value.id !== id),
          next,
        ]);
        if (saved) {
          this.notify('已保留选择，等待同步');
          this.sync();
        }
        return saved;
      } catch (error) {
        if (!this.disposed) this.notify(errorMessage(error));
        return false;
      }
    }, false);
}
const stores = new Map<string, AnnotationStore>();
export function annotationStore(
  key: string,
  identity: ReaderIdentity,
  notify: (message: string) => void,
) {
  let store = stores.get(key);
  if (!store) {
    store = new AnnotationStore(key, identity, notify);
    stores.set(key, store);
  }
  store.notify = notify;
  return store;
}
window.addEventListener('codesip:private-data-cleared', () => {
  stores.forEach((store) => store.dispose());
  stores.clear();
});

export async function syncLibraryAnnotations(
  userId: string,
  libraryId: string,
  signal?: AbortSignal,
) {
  let pending = 0;
  for (const identity of readerIdentities('annotations', userId, libraryId)) {
    const store = annotationStore(readerKey('annotations', identity), identity, () => {});
    signal?.throwIfAborted();
    await store.sync(signal);
    signal?.throwIfAborted();
    const state = store.getSnapshot();
    pending += state.error
      ? 1
      : state.annotations.filter((item) => item.syncStatus !== 'synced').length;
  }
  if (pending) throw new Error(`${pending} 条批注仍待处理，请检查冲突或重试同步`);
}
export function mergeLibraryAnnotations(
  userId: string,
  libraryId: string,
  records: ReaderAnnotation[],
) {
  const paths = new Set([
    ...readerIdentities('annotations', userId, libraryId).map((i) => i.path),
    ...records.map((r) => r.path),
  ]);
  for (const path of paths) {
    const identity = { userId, libraryId, path };
    annotationStore(readerKey('annotations', identity), identity, () => {}).mergeRemote(
      records.filter((r) => r.path === path),
    );
  }
}
export function annotationPendingCount(userId: string) {
  let pending = 0;
  for (const identity of readerIdentities('annotations', userId)) {
    const state = annotationStore(
      readerKey('annotations', identity),
      identity,
      () => {},
    ).getSnapshot();
    pending += state.error ? 1 : state.annotations.filter((a) => a.syncStatus !== 'synced').length;
  }
  return pending;
}

window.addEventListener('codesip:library-removed', (event) => {
  const { userId, libraryId } = (event as CustomEvent<{ userId: string; libraryId: string }>)
    .detail;
  for (const [key, store] of stores) {
    if (key.includes(`:v2:${userId}:${libraryId}:`)) {
      store.dispose();
      stores.delete(key);
    }
  }
});
