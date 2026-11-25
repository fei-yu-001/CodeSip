import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from './helpers/backend';
import type { Annotation } from '../web/src/annotationSync';

const memory = new Map<string, string>();
const browserEvents = new EventTarget();
let online = true;
Object.defineProperty(globalThis, 'window', { configurable: true, value: browserEvents });
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    get onLine() {
      return online;
    },
  },
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  },
});
const { annotationStore } = await import('../web/src/annotationSync');
const originalFetch = globalThis.fetch;
const reset = () => browserEvents.dispatchEvent(new Event('codesip:private-data-cleared'));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Timed out waiting for annotation operation');
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(t: TestContext) {
  reset();
  memory.clear();
  online = true;
  const instance = await buildApp({
    database: ':memory:',
    setupToken: 'annotation-client-test-key',
    rateLimit: false,
  });
  await instance.app.ready();
  const user = await instance.store.createUser('client-reader', 'client-reader-password');
  const library = instance.store.createLibrary(user.id, '合成批注', 'notes');
  instance.store.sync(user.id, library.id, {
    baseRevision: 0,
    deleted: [],
    upserts: [{ path: 'test.md', content: Buffer.from('# 合成测试\n只读原文').toString('base64') }],
  });
  const headers = {
    cookie: `codesip_session=${instance.store.session(user.id)}`,
    origin: 'http://127.0.0.1:4318',
  };
  const identity = { userId: user.id, libraryId: library.id, path: 'test.md' };
  const key = `codesip:annotations:v2:${user.id}:${library.id}:test.md`;
  const messages: string[] = [];
  const create = () => annotationStore(key, identity, (message) => messages.push(message));
  const fetchApi: typeof fetch = async (input, init = {}) => {
    if (!online) throw new TypeError('offline');
    const response = await instance.app.inject({
      method: (init.method || 'GET') as 'GET' | 'PUT' | 'DELETE',
      url: String(input),
      headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      payload: init.body as string | undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.fetch = fetchApi;
  t.after(async () => {
    reset();
    globalThis.fetch = originalFetch;
    online = true;
    await instance.app.close();
  });
  const list = () => instance.store.annotations.list(user.id, library.id, 'test.md');
  const make = (id: string, note: string): Annotation => ({
    id,
    note,
    line: 2,
    snippet: '只读原文',
    createdAt: Date.now(),
  });
  return { ...instance, user, library, headers, key, create, fetchApi, list, make, messages };
}

test('client serializes delayed reads and writes while retaining newer edits and other annotations', async (t) => {
  const f = await fixture(t);
  const store = f.create();
  const read = gate(),
    write = gate();
  let readStarted = false,
    writeStarted = false;
  globalThis.fetch = async (input, init) => {
    const response = await f.fetchApi(input, init);
    if (!init?.method && !readStarted) {
      readStarted = true;
      await read.promise;
    }
    if (init?.method === 'PUT' && !writeStarted) {
      writeStarted = true;
      await write.promise;
    }
    return response;
  };
  store.reload();
  await until(() => readStarted);
  const first = f.make('first', '初稿');
  assert.ok(store.persist([first], { type: 'save', item: first }));
  read.release();
  await until(() => writeStarted);
  const secondEdit = { ...store.getSnapshot().annotations[0], note: '请求期间的新修改' };
  const other = f.make('other', '另一条批注');
  store.persist([secondEdit], { type: 'save', item: secondEdit });
  store.persist([other], { type: 'save', item: other });
  write.release();
  await until(
    () =>
      store.getSnapshot().annotations.length === 2 &&
      store.getSnapshot().annotations.every((item) => item.syncStatus === 'synced'),
  );
  assert.deepEqual(
    f
      .list()
      .map((item) => item.note)
      .sort(),
    ['请求期间的新修改', '另一条批注'].sort(),
  );
  assert.equal(JSON.parse(memory.get(f.key)!).length, 2);
  assert.equal(f.store.manifest(f.user.id, f.library.id).library.revision, 1);
});

test('client recovers lost acknowledgements, retains offline drafts after reopening and resolves conflicts explicitly', async (t) => {
  const f = await fixture(t);
  let store = f.create();
  let loseResponse = true;
  globalThis.fetch = async (input, init) => {
    const response = await f.fetchApi(input, init);
    if (init?.method === 'PUT' && loseResponse) {
      loseResponse = false;
      throw new TypeError('lost response');
    }
    return response;
  };
  const initial = f.make('recover', '响应丢失但服务端已提交');
  store.persist([initial], { type: 'save', item: initial });
  await until(() => !!store.getSnapshot().annotations[0]?.lastError);
  assert.equal(f.list().length, 1);
  reset();
  store = f.create();
  store.reload();
  await until(() => store.getSnapshot().annotations[0]?.syncStatus === 'synced');
  assert.equal(f.list().length, 1);
  const base = store.getSnapshot().annotations[0];
  online = false;
  store.persist([], { type: 'save', item: { ...base, note: '离线保留的草稿' } });
  reset();
  store = f.create();
  store.reload();
  await delay(10);
  assert.equal(store.getSnapshot().annotations[0].note, '离线保留的草稿');
  const otherDevice = f.store.annotations.put(f.user.id, f.library.id, base.id, {
    path: 'test.md',
    line: base.line,
    snippet: base.snippet,
    note: '另一台设备的更新',
    expectedUpdatedAt: base.updatedAt!,
  });
  online = true;
  store.reload();
  await until(() => store.getSnapshot().annotations[0]?.syncStatus === 'conflict');
  assert.equal(f.list()[0].note, '另一台设备的更新');
  assert.equal(store.getSnapshot().annotations[0].note, '离线保留的草稿');
  assert.ok(await store.resolveConflict(base.id, 'local'));
  await until(() => store.getSnapshot().annotations[0]?.syncStatus === 'synced');
  assert.equal(f.list()[0].note, '离线保留的草稿');
  assert.ok(f.list()[0].updatedAt > otherDevice.updatedAt);

  const synced = store.getSnapshot().annotations[0];
  f.store.annotations.delete(f.user.id, f.library.id, synced.id, synced.updatedAt);
  online = false;
  store.persist([], { type: 'save', item: { ...synced, note: '保留为一条新批注' } });
  online = true;
  store.reload();
  await until(() => store.getSnapshot().annotations[0]?.syncStatus === 'conflict');
  assert.ok(await store.resolveConflict(synced.id, 'local'));
  await until(() => store.getSnapshot().annotations[0]?.syncStatus === 'synced');
  assert.notEqual(f.list()[0].id, synced.id);
  assert.equal(f.list()[0].note, '保留为一条新批注');
});

test('client retains an offline deletion across reopening and retries a failed delete without resurrection', async (t) => {
  const f = await fixture(t);
  let store = f.create();
  const initial = f.make('delete-me', '待删除的合成批注');
  store.persist([initial], { type: 'save', item: initial });
  await until(() => store.getSnapshot().annotations[0]?.syncStatus === 'synced');
  online = false;
  store.persist([], { type: 'delete', item: store.getSnapshot().annotations[0] });
  assert.equal(store.getSnapshot().annotations[0].syncStatus, 'deleting');
  reset();
  store = f.create();
  online = true;
  let failDelete = true;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'DELETE' && failDelete) {
      failDelete = false;
      return new Response(JSON.stringify({ error: '暂时失败' }), { status: 503 });
    }
    return f.fetchApi(input, init);
  };
  store.reload();
  await until(() => !!store.getSnapshot().annotations[0]?.lastError);
  assert.equal(store.getSnapshot().annotations[0].syncStatus, 'deleting');
  assert.equal(f.list().length, 1);
  store.sync();
  await until(() => store.getSnapshot().annotations.length === 0);
  assert.equal(f.list().length, 0);
  store.reload();
  await delay(10);
  assert.deepEqual(store.getSnapshot().annotations, []);
});

test('client clearing private data invalidates late responses and does not recreate local annotations', async (t) => {
  const f = await fixture(t);
  const store = f.create(),
    response = gate();
  let started = false,
    returned = false;
  globalThis.fetch = async (input, init) => {
    const result = await f.fetchApi(input, init);
    started = true;
    await response.promise;
    returned = true;
    return result;
  };
  const item = f.make('late', '退出之前已发出的批注');
  store.persist([item], { type: 'save', item });
  await until(() => started);
  reset();
  memory.clear();
  response.release();
  await until(() => returned);
  await delay(10);
  assert.equal(memory.get(f.key), undefined);
  assert.equal(f.list().length, 1);
  assert.equal(f.messages.includes('批注已同步'), false);
});

test('client preserves the editor base version when a background refresh discovers a remote edit', async (t) => {
  const f = await fixture(t);
  const store = f.create();
  const item = f.make('editor', '打开编辑器时的版本');
  store.persist([], { type: 'save', item });
  await until(() => store.getSnapshot().annotations[0]?.syncStatus === 'synced');
  const editor = { ...store.getSnapshot().annotations[0] };
  f.store.annotations.put(f.user.id, f.library.id, editor.id, {
    path: 'test.md',
    line: editor.line,
    snippet: editor.snippet,
    note: '编辑器打开期间其他设备的更新',
    expectedUpdatedAt: editor.updatedAt!,
  });
  store.reload();
  await until(() => store.getSnapshot().annotations[0]?.note === '编辑器打开期间其他设备的更新');
  store.persist([], { type: 'save', item: { ...editor, note: '编辑器里尚未提交的草稿' } });
  await until(() => store.getSnapshot().annotations[0]?.syncStatus === 'conflict');
  assert.equal(f.list()[0].note, '编辑器打开期间其他设备的更新');
  assert.equal(store.getSnapshot().annotations[0].note, '编辑器里尚未提交的草稿');
});
