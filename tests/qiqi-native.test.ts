import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import {
  createNativeQiqiFetch,
  QiqiNativeError,
  type QiqiNativeBridge,
} from '../web/src/qiqiNative';
import { streamQiqiCompletion } from '../web/src/qiqiTransport';

// Execute the actual ArkTS bridge with an SDK double. Native compilation separately
// checks the real SDK types; this suite exercises policy, lifecycle and wire behavior.
type Events = {
  onHeaderReceive(headers: Record<string, string>): void;
  onDataReceive(bytes: ArrayBuffer): number;
  onStatusCodeReceive?(status: number): void;
};
class Request {
  configuration!: {
    transfer: { autoRedirect: boolean; timeout: object };
    security: { remoteValidation: string };
    tracing: { verbose: boolean; plaintextInException: boolean; httpEventsHandler: Events };
  };
  constructor(
    public url: string,
    public method: string,
    public headers: Record<string, string>,
    public content: string,
  ) {}
}
class Session {
  request?: Request;
  closed = 0;
  resolve!: (value: { statusCode: number; headers: Record<string, string> }) => void;
  reject!: (error: object) => void;
  constructor(public configuration?: object) {}
  fetch(request: Request) {
    this.request = request;
    return new Promise<{ statusCode: number; headers: Record<string, string> }>(
      (resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      },
    );
  }
  close() {
    this.closed++;
    this.reject?.({ code: 1007900042 });
  }
  get events() {
    return this.request!.configuration.tracing.httpEventsHandler;
  }
  headers(status = 200, contentType = 'text/event-stream') {
    this.events.onStatusCodeReceive?.(status);
    this.events.onHeaderReceive({ 'content-type': contentType });
  }
  data(value: string | Uint8Array) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    this.events.onDataReceive(bytes.slice().buffer);
  }
  end(statusCode = 200, contentType = 'text/event-stream') {
    this.resolve({ statusCode, headers: { 'content-type': contentType } });
  }
}
const sessions: Session[] = [];
const deviceInfo = { sdkApiVersion: 20 };
const sdk = {
  deviceInfo,
  rcp: {
    Request,
    createSession: (configuration: object) => {
      const session = new Session(configuration);
      sessions.push(session);
      return session;
    },
  },
  url: { URL: { parseURL: (value: string) => new URL(value) } },
  util: {
    Base64Helper: class {
      encodeToStringSync(value: Uint8Array) {
        return Buffer.from(value).toString('base64');
      }
    },
  },
};
Object.assign(globalThis, { __qiqiNativeSDK: sdk });
const compiled = await build({
  entryPoints: ['harmony/entry/src/main/ets/qiqi/QiqiBridge.ets'],
  loader: { '.ets': 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'native-sdk-double',
      setup(context) {
        context.onResolve({ filter: /^@kit\./ }, (args) => ({ path: args.path, namespace: 'sdk' }));
        context.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({
          contents: 'export const { rcp, url, util, deviceInfo } = globalThis.__qiqiNativeSDK;',
          loader: 'js',
        }));
      },
    },
  ],
});
const native = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
const config = {
  baseUrl: 'https://model.example/v1',
  model: 'synthetic-model',
  apiKey: 'synthetic-native-key',
  rememberKey: false,
};
const input = {
  id: 'synthetic-id',
  endpoint: `${config.baseUrl}/chat/completions`,
  authorization: `Bearer ${config.apiKey}`,
  body: '{}',
};
const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
function fixture(t: TestContext, apiVersion = 20) {
  deviceInfo.sdkApiVersion = apiVersion;
  sessions.length = 0;
  const page = { main: 'https://codesip.ddyu.online/', frame: 'https://codesip.ddyu.online/' };
  const bridge: QiqiNativeBridge & { cancelAll(): void } = new native.QiqiBridge({
    getUrl: () => page.main,
    getLastJavascriptProxyCallingFrameUrl: () => page.frame,
  });
  t.after(() => bridge.cancelAll());
  const fetcher = createNativeQiqiFetch(bridge);
  const abort = new AbortController();
  const partials: string[] = [];
  const run = () =>
    streamQiqiCompletion({
      config,
      messages: [{ role: 'user', content: 'SYNTHETIC_QUESTION' }],
      signal: abort.signal,
      onText: (value) => partials.push(value),
      fetcher,
    });
  return { page, bridge, run, fetcher, abort, partials };
}
async function started() {
  await Promise.resolve();
  const session = sessions.at(-1)!;
  assert.ok(session?.request);
  return session;
}

test('Harmony native transport streams split UTF-8 through the existing parser and sends only explicit model fields', async (t) => {
  const f = fixture(t);
  const result = f.run();
  const session = await started();
  session.headers();
  const bytes = new TextEncoder().encode(delta('你好，七七🌱'));
  for (const byte of bytes) session.data(new Uint8Array([byte]));
  // The answer must render before the native request has completed.
  for (let i = 0; i < bytes.length + 10; i++) await Promise.resolve();
  assert.deepEqual(f.partials, ['你好，七七🌱']);
  session.data('data: [DONE]\n\n');
  assert.equal((await result).text, '你好，七七🌱');
  assert.equal(session.closed, 1);
  assert.deepEqual(session.request!.headers, {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    authorization: input.authorization,
    'cache-control': 'no-store',
  });
  const settings = session.request!.configuration;
  assert.equal(settings.transfer.autoRedirect, false);
  assert.equal(settings.security.remoteValidation, 'system');
  assert.equal(settings.tracing.verbose, false);
  assert.equal(session.configuration, undefined);
  assert.equal(session.request!.method, 'POST');
  assert.ok(!session.request!.content.includes(config.apiKey));
});

test('API 12–19 buffer within the size limit until HTTP status is known and preserve JSON responses', async (t) => {
  const f = fixture(t, 12);
  const result = f.run();
  const session = await started();
  assert.equal(session.events.onStatusCodeReceive, undefined);
  session.events.onHeaderReceive({ 'Content-Type': 'application/json' });
  session.data(JSON.stringify({ choices: [{ message: { content: '旧系统也可以回答' } }] }));
  await Promise.resolve();
  assert.deepEqual(f.partials, []);
  session.resolve({ statusCode: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await result).text, '旧系统也可以回答');
  assert.equal(session.closed, 1);
});

test('HTTP rejection, redirects and native exceptions cannot leak an upstream echoed key', async (t) => {
  for (const api of [12, 20]) {
    const f = fixture(t, api);
    const result = f.run();
    const rejection = assert.rejects(result, /API 拒绝访问/);
    const session = await started();
    session.headers(401, 'application/json');
    session.data(JSON.stringify({ error: config.apiKey }));
    session.end(401, 'application/json');
    await rejection;
    assert.deepEqual(f.partials, []);
  }
  for (const kind of ['redirect', 'network']) {
    const f = fixture(t);
    const result = f.run();
    const rejection = assert.rejects(result, (error: Error) => {
      assert.ok(error instanceof QiqiNativeError);
      assert.ok(!error.message.includes(config.apiKey));
      assert.match(error.message, kind === 'redirect' ? /跳转/ : /1007900007/);
      return true;
    });
    const session = await started();
    if (kind === 'redirect') {
      session.headers(307);
      session.end(307);
    } else session.reject({ code: 1007900007, message: config.apiKey });
    await rejection;
    assert.equal(session.closed, 1);
  }
});

test('native capability denies imported frames, lookalike origins and unsafe endpoints before networking', (t) => {
  const f = fixture(t);
  for (const frame of [
    'https://codesip.ddyu.online/api/raw',
    'https://codesip.ddyu.online.evil.example/',
    'about:blank',
    'https://other.example/',
    'http://codesip.ddyu.online/',
  ]) {
    f.page.frame = frame;
    assert.equal(f.bridge.version(), 0);
    assert.equal(
      f.bridge.start(JSON.stringify(input), () => {}),
      'unavailable',
    );
  }
  f.page.frame = f.page.main;
  for (const endpoint of [
    'http://model.example/v1/chat/completions',
    'https://user:password@model.example/v1/chat/completions',
    'https://model.example/v1/chat/completions?key=secret',
    'file:///chat/completions',
    'https://model.example/other',
  ]) {
    assert.equal(
      f.bridge.start(JSON.stringify({ ...input, endpoint }), () => {}),
      'invalid',
    );
  }
  assert.equal(
    f.bridge.start(
      JSON.stringify({ ...input, authorization: 'Bearer abc\r\nCookie: session' }),
      () => {},
    ),
    'invalid',
  );
  assert.equal(sessions.length, 0);
});

test('stop, body cancellation and native page teardown close requests and ignore late results', async (t) => {
  const f = fixture(t);
  const result = f.run();
  const rejection = assert.rejects(result, { name: 'AbortError' });
  const session = await started();
  session.headers();
  session.data(delta('开始'));
  f.abort.abort();
  await rejection;
  assert.equal(session.closed, 1);
  session.data(delta('不应出现'));
  assert.ok(!f.partials.includes('开始不应出现'));
  const next = fixture(t);
  const pending = next.fetcher(input.endpoint, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    body: '{}',
  });
  const second = await started();
  second.headers();
  second.data('first');
  const response = await pending;
  await response.body!.cancel();
  assert.equal(second.closed, 1);
  assert.equal(
    next.bridge.start(JSON.stringify(input), () => {}),
    'ok',
  );
  const third = await started();
  next.bridge.cancelAll();
  assert.equal(third.closed, 1);
});

test('native size and time bounds release the request even before headers arrive', async (t) => {
  const f = fixture(t, 12);
  const result = f.run();
  const rejected = assert.rejects(result, /数据过大/);
  const session = await started();
  session.data(new Uint8Array(4 * 1024 * 1024 + 1));
  await rejected;
  assert.equal(session.closed, 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const next = fixture(t);
  const timeout = assert.rejects(next.run(), /超时/);
  const second = await started();
  t.mock.timers.tick(120001);
  await timeout;
  assert.equal(second.closed, 1);
});

test('unsupported bridge and invalid request fail without sending or retrying', async () => {
  let calls = 0;
  const fetcher = createNativeQiqiFetch({
    version: () => 2,
    start: () => {
      calls++;
      return 'ok';
    },
    cancel: () => {},
  });
  await assert.rejects(
    fetcher(input.endpoint, { method: 'POST', credentials: 'omit', redirect: 'error', body: '{}' }),
    /更新.*安装包/,
  );
  await assert.rejects(
    fetcher(input.endpoint, {
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      body: '{}',
    }),
    /格式/,
  );
  assert.equal(calls, 0);
});
