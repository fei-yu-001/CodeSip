import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { annotationStore, parseAnnotations } from './annotationSync';
export type { Annotation, AnnotationSyncStatus } from './annotationSync';

export type ReaderTheme = 'paper-light' | 'warm-slate' | 'sepia-parchment';
import { readerKey, type ReaderIdentity } from './readerIdentity';
export { readerKey, type ReaderIdentity } from './readerIdentity';
export interface OutlineItem {
  name: string;
  line: number;
  level?: number;
}
export function readTheme(): ReaderTheme {
  try {
    const value =
      localStorage.getItem('codesip:reader-theme') || localStorage.getItem('codesip:theme');
    return value === 'warm-slate' || value === 'dark'
      ? 'warm-slate'
      : value === 'sepia-parchment'
        ? value
        : 'paper-light';
  } catch {
    return 'paper-light';
  }
}
export function useAnnotations(
  identity: ReaderIdentity,
  notify: (message: string) => void,
  includeLegacy = false,
) {
  const key = readerKey('annotations', identity);
  const store = useMemo(() => annotationStore(key, identity, notify), [key]);
  store.notify = notify;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const legacy = useMemo(() => {
    if (!includeLegacy) return [];
    try {
      return parseAnnotations(localStorage.getItem(`codesip:annotations:${identity.path}`));
    } catch {
      return [];
    }
  }, [key, includeLegacy]);
  useEffect(() => {
    void store.loadOnce();
  }, [store]);
  return {
    ...snapshot,
    persist: store.persist,
    sync: store.sync,
    reload: store.reload,
    resolveConflict: store.resolveConflict,
    legacy: legacy.filter((item) => !snapshot.annotations.some((saved) => saved.id === item.id)),
  };
}

// Flush before leaving the file or backgrounding the app; never replace saved progress
// with the initial zero position while the reader is still laying out its content.
export function trackReadingPosition(element: HTMLElement, key: string, restore = true) {
  let position: { top: number; left: number } | undefined;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (
      saved &&
      Number.isFinite(saved.top) &&
      saved.top >= 0 &&
      Number.isFinite(saved.left) &&
      saved.left >= 0
    )
      position = saved;
  } catch {
    /* Reading remains available when storage is disabled. */
  }
  let restoring = restore && !!position;
  let changed = false;
  let current = { top: element.scrollTop, left: element.scrollLeft };
  let lastSaved = { ...current };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  const flush = () => {
    clearTimeout(timer);
    if (restoring) return;
    // pagehide can precede the scroll event. After a React unmount, the detached
    // element reports zero, so retain the last position observed while connected.
    if (element.isConnected) current = { top: element.scrollTop, left: element.scrollLeft };
    if (!changed && current.top === lastSaved.top && current.left === lastSaved.left) return;
    try {
      localStorage.setItem(key, JSON.stringify(current));
      lastSaved = { ...current };
    } catch {
      /* Best-effort progress, unlike explicit annotation saves. */
    }
    changed = false;
  };
  const restorePosition = () => {
    if (!restoring || !position) return;
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
    if (Math.abs(element.scrollTop - position.top) < 2) {
      restoring = false;
      current = { top: element.scrollTop, left: element.scrollLeft };
      lastSaved = { ...current };
    }
  };
  const interact = () => {
    restoring = false;
  };
  const scroll = () => {
    if (restoring) return;
    current = { top: element.scrollTop, left: element.scrollLeft };
    changed = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 180);
  };
  // Worker-parsed Markdown mounts progressively; retry saved pixel progress
  // as its surface grows, without overwriting it with the first short batch.
  const content = element.querySelector('.markdown-content');
  const resize =
    content && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(restorePosition)
      : undefined;
  if (content) resize?.observe(content);
  frame = requestAnimationFrame(restorePosition);
  element.addEventListener('load', restorePosition, true);
  element.addEventListener('scroll', scroll, { passive: true });
  for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown'])
    element.addEventListener(event, interact, { passive: true });
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', flush);
  return () => {
    cancelAnimationFrame(frame);
    resize?.disconnect();
    flush();
    element.removeEventListener('load', restorePosition, true);
    element.removeEventListener('scroll', scroll);
    for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown'])
      element.removeEventListener(event, interact);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', flush);
  };
}
