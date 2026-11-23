import { useEffect, useRef, useState } from 'react';
import type { ReaderDocumentCopy, DocumentCopyWrite } from '../../shared/types';
import { api, HttpError } from './api';
import { readerKey, type ReaderIdentity } from './readerState';

type Draft = Omit<DocumentCopyWrite, 'path'>;
interface CopyState {
  copy: ReaderDocumentCopy | null;
  draft: Draft | null;
}
function read(key: string): CopyState {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (!value) return { copy: null, draft: null };
    const valid = (item: any) =>
      typeof item?.content === 'string' && /^[a-f0-9]{64}$/.test(item?.baseHash);
    return {
      copy: valid(value.copy) && Number.isSafeInteger(value.copy.updatedAt) ? value.copy : null,
      draft:
        valid(value.draft) &&
        (value.draft.expectedUpdatedAt === null ||
          Number.isSafeInteger(value.draft.expectedUpdatedAt))
          ? value.draft
          : null,
    };
  } catch {
    return { copy: null, draft: null };
  }
}
export function useDocumentCopy(
  identity: ReaderIdentity,
  source: string,
  sourceHash: string,
  enabled: boolean,
) {
  const key = readerKey('document', identity);
  const [state, setState] = useState<CopyState>(() =>
    enabled ? read(key) : { copy: null, draft: null },
  );
  const ref = useRef(state);
  const active = useRef(true);
  const loadingId = useRef(0);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!enabled);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [conflict, setConflict] = useState<ReaderDocumentCopy | null>(null);
  const endpoint = `/libraries/${identity.libraryId}/document-copy`;
  const persist = (next: CopyState) => {
    if (!active.current) return false;
    ref.current = next;
    setState(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStorageError('');
      return true;
    } catch {
      setStorageError('本机空间不足，草稿尚未存好。请先保存到云端或下载备份。');
      return false;
    }
  };
  const load = async () => {
    if (!enabled || !active.current || saving.current) return;
    const id = ++loadingId.current;
    try {
      const { copy } = await api<{ copy: ReaderDocumentCopy | null }>(
        `${endpoint}?path=${encodeURIComponent(identity.path)}`,
      );
      if (!active.current || id !== loadingId.current) return;
      persist({ ...ref.current, copy });
      setError('');
    } catch (e) {
      if (!active.current || id !== loadingId.current) return;
      setError(
        e instanceof HttpError && e.status === 401
          ? '登录已过期，草稿保留在本机。请重新登录后保存。'
          : '暂时无法读取云端编辑版，联网后可重试。',
      );
    } finally {
      if (active.current && id === loadingId.current) setLoaded(true);
    }
  };
  useEffect(() => {
    active.current = true;
    void load();
    const clear = () => {
      active.current = false;
      loadingId.current++;
    };
    window.addEventListener('online', load);
    window.addEventListener('focus', load);
    window.addEventListener('codesip:annotations-refresh', load);
    window.addEventListener('codesip:private-data-cleared', clear);
    return () => {
      clear();
      window.removeEventListener('online', load);
      window.removeEventListener('focus', load);
      window.removeEventListener('codesip:annotations-refresh', load);
      window.removeEventListener('codesip:private-data-cleared', clear);
    };
  }, [key, enabled]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (saving.current || (storageError && ref.current.draft)) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (storageError && ref.current.draft) {
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
  }, [storageError]);
  const change = (content: string) => {
    const current = ref.current;
    const draft = current.draft || {
      content: '',
      baseHash: current.copy?.baseHash || sourceHash,
      expectedUpdatedAt: current.copy?.updatedAt ?? null,
    };
    persist({ ...current, draft: { ...draft, content } });
  };
  const save = async (expectedVersion?: number) => {
    const draft = ref.current.draft;
    if (!draft || saving.current || !active.current) return false;
    saving.current = true;
    loadingId.current++;
    setBusy(true);
    setError('');
    try {
      const { copy } = await api<{ copy: ReaderDocumentCopy }>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          ...draft,
          path: identity.path,
          expectedUpdatedAt: expectedVersion ?? draft.expectedUpdatedAt,
        }),
      });
      if (!active.current) return false;
      persist({ copy, draft: ref.current.draft === draft ? null : ref.current.draft });
      setConflict(null);
      return true;
    } catch (e) {
      if (!active.current) return false;
      if (e instanceof HttpError && e.status === 409) {
        try {
          const { copy } = await api<{ copy: ReaderDocumentCopy | null }>(
            `${endpoint}?path=${encodeURIComponent(identity.path)}`,
          );
          if (active.current) {
            setConflict(copy);
            setError('其他设备已修改这份编辑版，请核对后选择要保留的版本。');
          }
        } catch {
          if (active.current) setError('云端版本有变化，暂时无法读取。草稿已保留，请重试保存。');
        }
      } else {
        setError(
          e instanceof HttpError
            ? e.message
            : '暂时无法保存到云端，草稿保留在本机。联网后请重试保存。',
        );
      }
      return false;
    } finally {
      saving.current = false;
      if (active.current) setBusy(false);
    }
  };
  const adoptRemote = () => {
    if (!conflict) return;
    persist({ copy: conflict, draft: null });
    setConflict(null);
    setError('');
  };
  return {
    ...state,
    content: state.draft?.content ?? state.copy?.content ?? source,
    loaded,
    busy,
    error,
    storageError,
    conflict,
    change,
    save,
    adoptRemote,
    reload: load,
  };
}
export type DocumentCopyController = ReturnType<typeof useDocumentCopy>;
