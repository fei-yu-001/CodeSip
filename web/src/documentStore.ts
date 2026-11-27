import type { ReaderDocumentCopy, DocumentCopyWrite } from '../../shared/types';
import { api, HttpError } from './api';
import {
  readerKey,
  readerIdentities,
  wasReaderLoaded,
  type ReaderIdentity,
} from './readerIdentity';

type Draft = Omit<DocumentCopyWrite, 'path'>;
interface CopyState {
  copy: ReaderDocumentCopy | null;
  draft: Draft | null;
}
export function sameDocumentCopy(
  a: ReaderDocumentCopy | null | undefined,
  b: ReaderDocumentCopy | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.path === right.path &&
    left.content === right.content &&
    left.baseHash === right.baseHash &&
    left.updatedAt === right.updatedAt
  );
}
export function sameCopyState(a: CopyState, b: CopyState): boolean {
  if (a === b) return true;
  if (!sameDocumentCopy(a.copy, b.copy)) return false;
  if (a.draft === b.draft) return true;
  if (!a.draft || !b.draft) return false;
  return (
    a.draft.content === b.draft.content &&
    a.draft.baseHash === b.draft.baseHash &&
    a.draft.expectedUpdatedAt === b.draft.expectedUpdatedAt
  );
}
export function writeCopyStateToStorage(
  key: string,
  next: CopyState,
  current: CopyState,
  hadStorageError: boolean,
): { changed: boolean; ok: boolean } {
  const unchanged = sameCopyState(current, next);
  if (unchanged && !hadStorageError) {
    return { changed: false, ok: true };
  }
  try {
    if (next.copy === null && next.draft === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(next));
    }
    return { changed: !unchanged, ok: true };
  } catch {
    return { changed: !unchanged, ok: false };
  }
}
function read(key: string): CopyState {
  const value = JSON.parse(localStorage.getItem(key) || 'null');
  if (!value) return { copy: null, draft: null };
  const valid = (item: any) =>
    typeof item?.content === 'string' && /^[a-f0-9]{64}$/.test(item?.baseHash);
  if (
    (value.copy !== null && !(valid(value.copy) && Number.isSafeInteger(value.copy.updatedAt))) ||
    (value.draft !== null &&
      !(
        valid(value.draft) &&
        (value.draft.expectedUpdatedAt === null ||
          Number.isSafeInteger(value.draft.expectedUpdatedAt))
      ))
  )
    throw new Error('本机编辑版读取失败，暂不能覆盖保存');
  return { copy: value.copy, draft: value.draft };
}
interface Snapshot extends CopyState {
  busy: boolean;
  error: string;
  storageError: string;
  conflict: ReaderDocumentCopy | null;
}
class DocumentStore {
  private state: Snapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private corrupt = false;
  private controller?: AbortController;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private key: string,
    private identity: ReaderIdentity,
  ) {
    this.state = {
      copy: null,
      draft: null,
      busy: false,
      error: '',
      storageError: '',
      conflict: null,
    };
    try {
      Object.assign(this.state, read(key));
    } catch {
      this.corrupt = true;
      this.state.storageError = '本机编辑版读取失败，暂不能覆盖保存';
    }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(value: Partial<Snapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    this.listeners.forEach((listener) => listener());
  }
  dispose() {
    this.disposed = true;
    this.controller?.abort();
    this.listeners.clear();
  }
  private persist(next: CopyState) {
    if (this.disposed || this.corrupt) return false;
    const { ok } = writeCopyStateToStorage(this.key, next, this.state, !!this.state.storageError);
    this.patch({
      ...next,
      storageError: ok ? '' : '本机空间不足，草稿尚未存好。请下载备份后重试。',
    });
    return ok;
  }
  change = (content: string, sourceHash: string) => {
    const draft = this.state.draft || {
      content: '',
      baseHash: this.state.copy?.baseHash || sourceHash,
      expectedUpdatedAt: this.state.copy?.updatedAt ?? null,
    };
    return this.persist({ copy: this.state.copy, draft: { ...draft, content } });
  };
  saveLocal = async () => this.persist({ copy: this.state.copy, draft: this.state.draft });
  private get endpoint() {
    return `/libraries/${encodeURIComponent(this.identity.libraryId)}/document-copy`;
  }
  private async request<T>(url: string, init: RequestInit = {}) {
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await api<T>(url, { ...init, signal: controller.signal });
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
  mergeRemote = (copy: ReaderDocumentCopy | null) => {
    if (this.disposed) return;
    const draft = this.state.draft;
    const acknowledged =
      !!draft && copy?.content === draft.content && copy?.baseHash === draft.baseHash;
    const conflict =
      !!draft && !acknowledged && (copy?.updatedAt ?? null) !== draft.expectedUpdatedAt;
    if (!this.persist({ copy, draft: acknowledged ? null : draft }))
      throw new Error(this.state.storageError);
    this.patch({
      conflict: conflict ? copy : null,
      error: conflict ? '其他设备已修改这份编辑版，请核对后选择要保留的版本。' : '',
    });
    localStorage.setItem(readerKey('document-loaded', this.identity), '1');
  };
  loadOnce = () => {
    if (wasReaderLoaded('document', this.identity)) return Promise.resolve();
    const operation = this.tail.then(async () => {
      if (this.disposed) return;
      try {
        const { copy } = await this.request<{ copy: ReaderDocumentCopy | null }>(
          `${this.endpoint}?path=${encodeURIComponent(this.identity.path)}`,
        );
        this.mergeRemote(copy);
      } catch {
        /* Reading and local edits do not wait for a connection. Explicit sync retries. */
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  };
  sync = (expectedVersion?: number): Promise<boolean> => {
    const operation = this.tail.then(() => this.upload(expectedVersion));
    this.tail = operation.catch(() => {});
    return operation;
  };
  private async upload(expectedVersion?: number) {
    const draft = this.state.draft;
    if (this.disposed || this.corrupt || !draft) return !this.corrupt;
    if (this.state.conflict && expectedVersion === undefined) return false;
    if (!this.persist({ copy: this.state.copy, draft })) return false;
    this.patch({ busy: true, error: '' });
    try {
      const { copy } = await this.request<{ copy: ReaderDocumentCopy }>(this.endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          ...draft,
          path: this.identity.path,
          expectedUpdatedAt: expectedVersion ?? draft.expectedUpdatedAt,
        }),
      });
      if (this.disposed) return false;
      const latest = this.state.draft;
      const next =
        latest === draft ? null : latest ? { ...latest, expectedUpdatedAt: copy.updatedAt } : null;
      const saved = this.persist({ copy, draft: next });
      this.patch({ conflict: null });
      return saved;
    } catch (error) {
      if (this.disposed) return false;
      if (error instanceof HttpError && error.status === 409) {
        try {
          const { copy } = await this.request<{ copy: ReaderDocumentCopy | null }>(
            `${this.endpoint}?path=${encodeURIComponent(this.identity.path)}`,
          );
          this.mergeRemote(copy);
          if (!this.state.draft) return true;
        } catch {
          this.patch({ error: '云端版本有变化，暂时无法读取。草稿已保留，请重试同步。' });
        }
      } else
        this.patch({
          error:
            error instanceof HttpError
              ? error.message
              : '同步未完成，编辑版保留在本机，请联网后重试。',
        });
      return false;
    } finally {
      this.patch({ busy: false });
    }
  }
  adoptRemote = () => {
    if (!this.state.conflict) return;
    if (this.persist({ copy: this.state.conflict, draft: null }))
      this.patch({ conflict: null, error: '' });
  };
}
const stores = new Map<string, DocumentStore>();
export function documentStore(identity: ReaderIdentity) {
  const key = readerKey('document', identity);
  let store = stores.get(key);
  if (!store) {
    store = new DocumentStore(key, identity);
    stores.set(key, store);
  }
  return store;
}
export async function syncLibraryDocumentCopies(userId: string, libraryId: string) {
  for (const identity of readerIdentities('document', userId, libraryId))
    await documentStore(identity).sync();
}
export function mergeLibraryDocumentCopies(
  userId: string,
  libraryId: string,
  copies: ReaderDocumentCopy[],
) {
  const paths = new Set([
    ...readerIdentities('document', userId, libraryId).map((i) => i.path),
    ...copies.map((c) => c.path),
  ]);
  for (const path of paths)
    documentStore({ userId, libraryId, path }).mergeRemote(
      copies.find((c) => c.path === path) || null,
    );
}
export function documentPendingCount(userId: string) {
  return readerIdentities('document', userId).filter((identity) => {
    const state = documentStore(identity).getSnapshot();
    return state.draft || state.storageError;
  }).length;
}
window.addEventListener('codesip:private-data-cleared', () => {
  stores.forEach((store) => store.dispose());
  stores.clear();
});

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
