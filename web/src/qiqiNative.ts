// The installed Harmony app supplies this narrow bridge. Browsers keep using fetch.
// No automatic retry/fallback: a failed native request may already have reached the model.
export interface QiqiNativeBridge {
  version(): number;
  start(request: string, receive: (event: string) => void): string;
  cancel(id: string): void;
}
declare global {
  interface Window {
    CodeSipQiqi?: QiqiNativeBridge;
  }
}
const limit = 4 * 1024 * 1024;
export class QiqiNativeError extends Error {
  constructor(code = 'network', nativeCode?: number) {
    const messages: Record<string, string> = {
      unavailable: '请更新 CodeSip 鸿蒙安装包后再使用七七',
      invalid: 'API 请求格式不正确，请检查 API 设置',
      busy: '上一条回答仍在进行，请停止后重试',
      timeout: '模型连接超时，请检查手机网络或稍后重试',
      redirect: 'API 地址发生跳转，请在设置中填写最终的 HTTPS 接口地址',
      too_large: 'API 返回的数据过大，请缩小问题范围',
      tls: '手机无法验证 API 的安全连接，请检查设备时间和服务证书',
      dns: '手机无法解析 API 地址，请检查地址与手机网络',
    };
    super(
      messages[code] ||
        `手机连接模型失败${Number.isSafeInteger(nativeCode) ? `（${nativeCode}）` : ''}，请检查 API 地址与手机网络`,
    );
    this.name = 'QiqiNativeError';
  }
}

export function createNativeQiqiFetch(bridge: QiqiNativeBridge): typeof fetch {
  return async (input, init) => {
    const endpoint =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    if (
      init?.method !== 'POST' ||
      typeof init.body !== 'string' ||
      init.credentials !== 'omit' ||
      init.redirect !== 'error' ||
      [...headers.keys()].some((name) => !['content-type', 'authorization'].includes(name))
    )
      throw new QiqiNativeError('invalid');
    const signal = init.signal;
    signal?.throwIfAborted();
    try {
      if (bridge.version() !== 1) throw new QiqiNativeError('unavailable');
    } catch {
      throw new QiqiNativeError('unavailable');
    }
    const id = crypto.randomUUID();
    return new Promise<Response>((resolve, reject) => {
      let settled = false,
        closed = false,
        bytes = 0;
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      let timer: ReturnType<typeof setTimeout>;
      const cancelNative = () => {
        try {
          bridge.cancel(id);
        } catch {
          /* Page may be closing. */
        }
      };
      const cleanup = () => {
        closed = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        if (typeof window !== 'undefined') window.removeEventListener('pagehide', hidden);
      };
      const fail = (error: unknown) => {
        if (closed) return;
        cleanup();
        cancelNative();
        streamController.error(error);
        if (!settled) reject(error);
      };
      const aborted = () => fail(signal?.reason || new DOMException('Aborted', 'AbortError'));
      const hidden = () => fail(new DOMException('Page closed', 'AbortError'));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          if (!closed) {
            cleanup();
            cancelNative();
          }
        },
      });
      const receive = (raw: string) => {
        if (closed) return;
        try {
          if (typeof raw !== 'string' || raw.length > limit * 2)
            throw new QiqiNativeError('too_large');
          const event = JSON.parse(raw);
          if (event.id !== id) return;
          if (event.type === 'headers') {
            if (
              settled ||
              !Number.isInteger(event.status) ||
              event.status < 200 ||
              event.status > 599
            )
              throw new QiqiNativeError();
            if (event.status >= 300 && event.status < 400) throw new QiqiNativeError('redirect');
            const contentType =
              typeof event.contentType === 'string' ? event.contentType.slice(0, 200) : '';
            const response = new Response([204, 205, 304].includes(event.status) ? null : body, {
              status: event.status,
              headers: { 'content-type': contentType },
            });
            settled = true;
            resolve(response);
            if (!response.body) {
              cleanup();
              cancelNative();
            }
          } else if (event.type === 'data') {
            if (!settled || typeof event.data !== 'string') throw new QiqiNativeError();
            const decoded = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
            bytes += decoded.byteLength;
            if (bytes > limit) throw new QiqiNativeError('too_large');
            streamController.enqueue(decoded);
          } else if (event.type === 'end') {
            if (!settled) throw new QiqiNativeError();
            cleanup();
            streamController.close();
          } else if (event.type === 'error') {
            throw new QiqiNativeError(event.code, event.nativeCode);
          } else throw new QiqiNativeError();
        } catch (error) {
          fail(error instanceof QiqiNativeError ? error : new QiqiNativeError());
        }
      };
      signal?.addEventListener('abort', aborted, { once: true });
      if (typeof window !== 'undefined')
        window.addEventListener('pagehide', hidden, { once: true });
      timer = setTimeout(() => fail(new QiqiNativeError('timeout')), 120000);
      if (signal?.aborted) {
        aborted();
        return;
      }
      try {
        const result = bridge.start(
          JSON.stringify({
            id,
            endpoint,
            authorization: headers.get('authorization') || '',
            body: init.body,
          }),
          receive,
        );
        if (result !== 'ok') fail(new QiqiNativeError(result));
      } catch {
        fail(new QiqiNativeError());
      }
    });
  };
}

export const qiqiFetch: typeof fetch = (input, init) => {
  const bridge = typeof window !== 'undefined' ? window.CodeSipQiqi : undefined;
  return bridge ? createNativeQiqiFetch(bridge)(input, init) : fetch(input, init);
};
