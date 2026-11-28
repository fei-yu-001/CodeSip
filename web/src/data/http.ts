export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(init.body instanceof FormData ? 180000 : 20000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const response = await fetch('/api' + url, {
    credentials: 'same-origin',
    ...init,
    signal,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });
  signal.throwIfAborted();
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: '请求失败' }));
    throw new HttpError(response.status, body.error);
  }
  const value = await response.json();
  signal.throwIfAborted();
  return value;
}
