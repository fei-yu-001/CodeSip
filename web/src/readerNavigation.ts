import { useEffect, useRef } from 'react';

const marker = 'codesipLayer';
let nextId = 0;

// ArkWeb's system back already follows Web history. A same-URL entry lets it
// dismiss the topmost sheet or fullscreen view before leaving the current file.
export function useDismissibleLayer(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let id: number | undefined;
    const url = location.href;
    queueMicrotask(() => {
      if (!alive) return;
      id = ++nextId;
      history.pushState({ ...history.state, [marker]: id }, '', url);
    });
    const pop = () => {
      const current = history.state?.[marker];
      if (id !== undefined && (typeof current !== 'number' || current < id)) closeRef.current();
    };
    const hash = () => {
      if (location.href !== url) closeRef.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && id !== undefined && history.state?.[marker] === id) {
        event.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('hashchange', hash);
    document.addEventListener('keydown', key);
    return () => {
      alive = false;
      window.removeEventListener('popstate', pop);
      window.removeEventListener('hashchange', hash);
      document.removeEventListener('keydown', key);
      if (id !== undefined && history.state?.[marker] === id && location.href === url)
        history.back();
    };
  }, [open]);
}

export function navigateHash(hash: string, replace = false) {
  const target = `#${hash}`;
  if (replace || history.state?.[marker] !== undefined) {
    // Reuse the temporary overlay entry when choosing a file from a drawer.
    // Returning then reaches the previous file without an extra empty history step.
    const oldURL = location.href;
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
  } else if (location.hash !== target) location.hash = hash;
}

export function clearStaleLayer() {
  if (history.state?.[marker] !== undefined) history.replaceState(null, '');
}
