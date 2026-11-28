export function abortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
