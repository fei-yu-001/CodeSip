// Account lifetime is independent of HTTP and browser storage. All asynchronous
// writers capture the generation; session invalidation cancels active work first.
let generation = 0;
let controller = new AbortController();
const cleaners = new Set<() => void>();
export const cacheGeneration = () => generation;
export const sessionSignal = () => controller.signal;
export function onPrivateDataCleared(cleaner: () => void): () => void {
  cleaners.add(cleaner);
  return () => {
    cleaners.delete(cleaner);
  };
}
export function invalidatePrivateData() {
  generation++;
  controller.abort();
  controller = new AbortController();
  for (const cleaner of cleaners) {
    try {
      cleaner();
    } catch {
      /* One feature must not block another's cleanup. */
    }
  }
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event('codesip:private-data-cleared'));
}
