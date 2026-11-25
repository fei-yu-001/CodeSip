import type {
  Library,
  Manifest,
  ReaderAnnotation,
  ReaderDocumentCopy,
  User,
} from '../../shared/types';
import {
  api,
  cacheGeneration,
  cached,
  cachedLibraries,
  downloadLibrary,
  manifestKey,
  HttpError,
  save,
} from './api';
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

// Local reading never invokes this queue. Only the explicit Sync action enters it.
export async function synchronizeLibraryData(
  user: User,
  progress: (value: string) => void,
  signal: AbortSignal,
  currentId?: string,
) {
  const generation = cacheGeneration();
  const check = () => {
    if (signal.aborted || generation !== cacheGeneration())
      throw new DOMException('同步已取消', 'AbortError');
  };
  progress('正在连接…');
  const { user: session } = await api<{ user: User }>('/session', { signal });
  check();
  if (session.id !== user.id) throw new HttpError(401, '账号已改变，请重新登录后同步');
  const { libraries } = await api<{ libraries: Library[] }>('/libraries', { signal });
  check();
  const pendingLibraries = new Set(
    [...readerIdentities('annotations', user.id), ...readerIdentities('document', user.id)].map(
      (i) => i.libraryId,
    ),
  );
  const targets = await Promise.all(
    libraries.map(async (library) => ({
      library,
      saved: !!(await cached<Manifest>(manifestKey(user, library.id))),
    })),
  );
  check();
  const ordered = targets
    .filter(
      ({ library, saved }) =>
        library.id === currentId || pendingLibraries.has(library.id) || (!currentId && saved),
    )
    .map(({ library }) => library)
    .sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));
  for (let i = 0; i < ordered.length; i++) {
    const library = ordered[i];
    progress(`同步项目 ${i + 1}/${ordered.length}`);
    const manifest = await api<Manifest>(`/libraries/${library.id}/manifest`, { signal });
    check();
    // Writes use the versions captured locally. Conflicts stay local for explicit resolution.
    await syncLibraryAnnotations(user.id, library.id);
    check();
    await syncLibraryDocumentCopies(user.id, library.id);
    check();
    const state = await api<{ annotations: ReaderAnnotation[]; copies: ReaderDocumentCopy[] }>(
      `/libraries/${library.id}/reader-state`,
      { signal },
    );
    check();
    mergeLibraryAnnotations(user.id, library.id, state.annotations);
    mergeLibraryDocumentCopies(user.id, library.id, state.copies);
    localStorage.setItem(snapshotKey(user.id, library.id), String(Date.now()));
    // Every changed blob is verified and persisted before switching the saved manifest.
    // A failed transfer leaves the previous complete revision readable.
    await downloadLibrary(
      user,
      manifest,
      (done, total) => progress(`项目 ${i + 1}/${ordered.length} · ${done}/${total}`),
      signal,
    );
    check();
  }
  // Retain local archives removed remotely; an explicit local delete can remove them.
  const local = (await cachedLibraries(user)) || [];
  check();
  const missing = local.filter((l) => !libraries.some((remote) => remote.id === l.id));
  const combined = [...libraries, ...missing];
  await save(`${user.id}:libraries`, combined);
  check();
  await save(`${user.id}:last-sync`, new Date().toISOString());
  return {
    libraries: combined,
    pending: annotationPendingCount(user.id) + documentPendingCount(user.id),
    localOnly: missing.length,
  };
}
