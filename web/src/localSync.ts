import type {
  Library,
  Manifest,
  ReaderAnnotation,
  ReaderDocumentCopy,
  User,
} from '../../shared/types';
import { api } from './data/http';
import { cached, save } from './data/localCache';
import { cachedLibraries, downloadLibrary, manifestKey } from './data/libraryRepository';
import { sessionSignal } from './data/session';
import {
  annotationPendingCount,
  mergeLibraryAnnotations,
  syncLibraryAnnotations,
} from './annotationSync';
import {
  documentPendingCount,
  mergeLibraryDocumentCopies,
  syncLibraryDocumentCopies,
} from './documentStore';
import { snapshotKey, readerIdentities } from './readerIdentity';
import { runLibrarySync } from './sync/librarySync';
export type { SyncResult } from './sync/librarySync';

// This adapter owns browser persistence. The scheduler only depends on typed
// operations and can be verified without a DOM, IndexedDB or live server.
export function synchronizeLibraryData(
  user: User,
  progress: (value: string) => void,
  signal: AbortSignal,
  currentId?: string,
  onlyIds?: string[],
) {
  const combined = AbortSignal.any([signal, sessionSignal()]);
  return runLibrarySync({
    user,
    progress,
    signal: combined,
    currentId,
    onlyIds,
    ports: {
      authenticate: async (signal) => (await api<{ user: User }>('/session', { signal })).user,
      list: async (signal) =>
        (await api<{ libraries: Library[] }>('/libraries', { signal })).libraries,
      localLibraries: async () => (await cachedLibraries(user)) || [],
      saved: async (id) => !!(await cached<Manifest>(manifestKey(user, id))),
      pendingLibraries: () =>
        [...readerIdentities('annotations', user.id), ...readerIdentities('document', user.id)].map(
          (identity) => identity.libraryId,
        ),
      manifest: (id, signal) => api<Manifest>(`/libraries/${id}/manifest`, { signal }),
      annotations: (id, signal) => syncLibraryAnnotations(user.id, id, signal),
      documents: (id, signal) => syncLibraryDocumentCopies(user.id, id, signal),
      readerState: (id, signal) =>
        api<{ annotations: ReaderAnnotation[]; copies: ReaderDocumentCopy[] }>(
          `/libraries/${id}/reader-state`,
          { signal },
        ),
      mergeAnnotations: (id, values) => mergeLibraryAnnotations(user.id, id, values),
      mergeDocuments: (id, values) => mergeLibraryDocumentCopies(user.id, id, values),
      markSnapshot: (id) => localStorage.setItem(snapshotKey(user.id, id), String(Date.now())),
      files: (manifest, report, signal) => downloadLibrary(user, manifest, report, signal, 'saved'),
      publish: async (libraries, complete) => {
        combined.throwIfAborted();
        await save(`${user.id}:libraries`, libraries);
        combined.throwIfAborted();
        if (complete) await save(`${user.id}:last-sync`, new Date().toISOString());
      },
      pending: () => annotationPendingCount(user.id) + documentPendingCount(user.id),
    },
  });
}
