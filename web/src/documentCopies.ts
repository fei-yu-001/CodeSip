import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { documentStore } from './documentStore';
import { readerKey, type ReaderIdentity } from './readerIdentity';
export { sameDocumentCopy, sameCopyState, writeCopyStateToStorage } from './documentStore';

export function useDocumentCopy(
  identity: ReaderIdentity,
  source: string,
  sourceHash: string,
  enabled: boolean,
) {
  const key = readerKey('document', identity);
  const store = useMemo(() => documentStore(identity), [key]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (enabled) void store.loadOnce();
  }, [store, enabled]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (state.busy || (state.storageError && state.draft)) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (state.storageError && state.draft) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('codesip:before-update', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('codesip:before-update', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [state.busy, state.storageError, state.draft]);
  return {
    ...state,
    content: enabled ? (state.draft?.content ?? state.copy?.content ?? source) : source,
    loaded: true,
    change: (content: string) => store.change(content, sourceHash),
    save: store.saveLocal,
    sync: store.sync,
    adoptRemote: store.adoptRemote,
  };
}
export type DocumentCopyController = ReturnType<typeof useDocumentCopy>;
