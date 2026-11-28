import { webview } from '@kit.ArkWeb';
import { rcp } from '@kit.RemoteCommunicationKit';
import { util, url } from '@kit.ArkTS';
import { deviceInfo, BusinessError } from '@kit.BasicServicesKit';

const ORIGIN = 'https://codesip.ddyu.online';
const RESPONSE_LIMIT = 4 * 1024 * 1024;
// Permission filtering plus a calling-frame check: imported documents never get this capability.
export const QIQI_BRIDGE_PERMISSION = '{"javascriptProxyPermission":{"urlPermissionList":' +
  '[{"scheme":"https","host":"codesip.ddyu.online","port":"","path":""}]}}';
interface BridgeRequest {
  id: string;
  endpoint: string;
  authorization: string;
  body: string;
}
interface BridgeEvent {
  id: string;
  type: string;
  status?: number;
  contentType?: string;
  data?: string;
  code?: string;
  nativeCode?: number;
}
class PendingRequest {
  id: string;
  session: rcp.Session;
  callback: (event: string) => void;
  status: number = 0;
  contentType: string = '';
  headersSent: boolean = false;
  bytes: number = 0;
  chunks: string[] = [];
  timer: number = -1;
  closed: boolean = false;
  constructor(id: string, session: rcp.Session, callback: (event: string) => void) {
    this.id = id;
    this.session = session;
    this.callback = callback;
  }
}

export class QiqiBridge {
  private controller: webview.WebviewController;
  private pending: Map<string, PendingRequest> = new Map();
  private base64: util.Base64Helper = new util.Base64Helper();
  constructor(controller: webview.WebviewController) { this.controller = controller; }

  private trustedPage(value: string): boolean {
    try {
      const page = url.URL.parseURL(value);
      return page.origin === ORIGIN && !page.username && !page.password &&
        (page.pathname === '/' || page.pathname === '/index.html');
    } catch (_) { return false; }
  }
  private allowed(): boolean {
    try {
      return this.trustedPage(this.controller.getUrl()) &&
        this.trustedPage(this.controller.getLastJavascriptProxyCallingFrameUrl());
    } catch (_) { return false; }
  }
  version(): number { return this.allowed() ? 1 : 0; }

  start(raw: string, callback: (event: string) => void): string {
    if (!this.allowed()) { return 'unavailable'; }
    if (typeof raw !== 'string' || raw.length > 1100000 || typeof callback !== 'function') { return 'invalid'; }
    let input: BridgeRequest;
    try {
      input = JSON.parse(raw) as BridgeRequest;
      if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) ||
        typeof input.endpoint !== 'string' || input.endpoint.length > 4096 ||
        typeof input.authorization !== 'string' || input.authorization.length > 4103 ||
        /[\r\n]/.test(input.authorization) ||
        (input.authorization !== '' && !input.authorization.startsWith('Bearer ')) ||
        typeof input.body !== 'string' || input.body.length > 1048576) { return 'invalid'; }
      const endpoint = url.URL.parseURL(input.endpoint);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
      if ((endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !endpoint.pathname.endsWith('/chat/completions')) { return 'invalid'; }
      // Reject malformed JSON before sending credentials. Do not interpret or execute its content.
      JSON.parse(input.body);
    } catch (_) { return 'invalid'; }
    if (this.pending.size > 0) { return 'busy'; }
    let session: rcp.Session;
    try {
      // A fresh session has no shared cookies or response cache.
      session = rcp.createSession();
    } catch (_) { return 'unavailable'; }
    const current = new PendingRequest(input.id, session, callback);
    this.pending.set(input.id, current);
    current.timer = setTimeout(() => { this.fail(current, 'timeout'); }, 120000);
    const events: rcp.HttpEventsHandler = {
      onHeaderReceive: (headers: rcp.ResponseHeaders) => {
        current.contentType = this.contentType(headers);
      },
      onDataReceive: (data: ArrayBuffer): number => {
        if (current.closed) { return 0; }
        current.bytes += data.byteLength;
        if (current.bytes > RESPONSE_LIMIT) { this.fail(current, 'too_large'); return 0; }
        const bytes = new Uint8Array(data);
        for (let offset = 0; offset < bytes.length && !current.closed; offset += 32768) {
          current.chunks.push(this.base64.encodeToStringSync(bytes.subarray(offset, offset + 32768)));
          this.flush(current);
        }
        return data.byteLength;
      },
    };
    // Status callbacks arrived in API 20. API 12–19 safely buffer the bounded body
    // until fetch resolves, so an HTTP error can never appear as a successful answer.
    if (deviceInfo.sdkApiVersion >= 20) {
      events.onStatusCodeReceive = (status: number) => {
        if (status >= 200) { current.status = status; }
      };
    }
    const headers: rcp.RequestHeaders = {
      'content-type': 'application/json', 'accept': 'text/event-stream, application/json', 'cache-control': 'no-store',
    };
    if (input.authorization) { headers['authorization'] = input.authorization; }
    let request: rcp.Request;
    try {
      request = new rcp.Request(input.endpoint, 'POST', headers, input.body);
      request.configuration = {
        transfer: { autoRedirect: false, timeout: { connectMs: 20000, transferMs: 120000, inactivityMs: 60000 } },
        security: { remoteValidation: 'system' },
        tracing: { verbose: false, httpEventsHandler: events },
      };
    } catch (_) { this.dispose(current); return 'invalid'; }
    // Start after the synchronous proxy call returns; all events go to this invocation's callback.
    Promise.resolve().then(async () => {
      if (current.closed) { return; }
      try {
        const response = await session.fetch(request);
        if (current.closed) { return; }
        current.status = response.statusCode;
        current.contentType = this.contentType(response.headers) || current.contentType;
        this.flush(current);
        if (!current.closed) {
          this.dispose(current);
          this.emit(current, { id: current.id, type: 'end' });
        }
      } catch (error) {
        if (current.closed) { return; }
        const code = (error as BusinessError).code;
        const kind = code === 1007900028 ? 'timeout' : code === 1007900006 ? 'dns' :
          (code === 1007900035 || code === 1007900060) ? 'tls' : 'network';
        this.fail(current, kind, code);
      }
    });
    return 'ok';
  }
  private contentType(headers: rcp.ResponseHeaders): string {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'content-type') {
        const value = headers[name];
        if (typeof value === 'string') { return value.slice(0, 200); }
      }
    }
    return '';
  }
  private flush(current: PendingRequest): void {
    if (current.closed || current.status < 200) { return; }
    if (current.status >= 300 && current.status < 400) { this.fail(current, 'redirect'); return; }
    if (!current.headersSent) {
      current.headersSent = true;
      this.emit(current, { id: current.id, type: 'headers', status: current.status, contentType: current.contentType });
    }
    const chunks = current.chunks;
    current.chunks = [];
    for (const data of chunks) {
      if (current.closed) { break; }
      this.emit(current, { id: current.id, type: 'data', data });
    }
  }
  private emit(current: PendingRequest, event: BridgeEvent): void {
    try { current.callback(JSON.stringify(event)); }
    catch (_) { this.dispose(current); }
  }
  private fail(current: PendingRequest, code: string, nativeCode?: number): void {
    if (current.closed) { return; }
    this.dispose(current);
    this.emit(current, { id: current.id, type: 'error', code, nativeCode });
  }
  private dispose(current: PendingRequest): void {
    if (current.closed) { return; }
    current.closed = true;
    clearTimeout(current.timer);
    current.chunks = [];
    this.pending.delete(current.id);
    try { current.session.close(); } catch (_) {}
  }
  cancel(id: string): void {
    if (!this.allowed()) { return; }
    const current = this.pending.get(id);
    if (current) { this.dispose(current); }
  }
  cancelAll(): void {
    this.pending.forEach((current: PendingRequest) => { this.dispose(current); });
  }
}
