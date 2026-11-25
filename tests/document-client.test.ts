import test from 'node:test';
import assert from 'node:assert/strict';
const events = new EventTarget();
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
let full = false;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (full) throw new DOMException('full', 'QuotaExceededError');
      memory.set(key, value);
    },
    removeItem: (key: string) => memory.delete(key),
  },
});
const { documentStore } = await import('../web/src/documentStore');
const identity = { userId: 'owner', libraryId: 'library', path: 'note.md' };
const key = 'codesip:document:v2:owner:library:note.md';
const hash = 'a'.repeat(64);
const nativeFetch = globalThis.fetch;
function reset() {
  events.dispatchEvent(new Event('codesip:private-data-cleared'));
  memory.clear();
  full = false;
  globalThis.fetch = nativeFetch;
}
test.afterEach(reset);
test('document edits persist locally across store recreation without making a network request', async () => {
  reset();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw Error('must stay local');
  };
  let store = documentStore(identity);
  store.change('local draft', hash);
  assert.ok(await store.saveLocal());
  events.dispatchEvent(new Event('codesip:private-data-cleared'));
  store = documentStore(identity);
  await store.loadOnce();
  assert.equal(requests, 0);
  assert.equal(store.getSnapshot().draft?.content, 'local draft');
});
test('a late upload acknowledgement preserves newer edits and advances their base version', async () => {
  reset();
  const store = documentStore(identity);
  store.change('first', hash);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started!: () => void;
  const sending = new Promise<void>((r) => {
    started = r;
  });
  globalThis.fetch = async () => {
    started();
    await gate;
    return Response.json({
      copy: { path: 'note.md', content: 'first', baseHash: hash, updatedAt: 123 },
    });
  };
  const sync = store.sync();
  await sending;
  store.change('newer local edit', hash);
  release();
  assert.ok(await sync);
  assert.equal(store.getSnapshot().draft?.content, 'newer local edit');
  assert.equal(store.getSnapshot().draft?.expectedUpdatedAt, 123);
  assert.equal(JSON.parse(memory.get(key)!).draft.content, 'newer local edit');
});
test('a lost acknowledgement is recovered on sync and a conflicting remote copy never replaces the local draft', async () => {
  reset();
  const store = documentStore(identity);
  store.change('local', hash);
  const remote = { path: 'note.md', content: 'local', baseHash: hash, updatedAt: 123 };
  globalThis.fetch = async () => {
    throw new TypeError('lost response');
  };
  assert.equal(await store.sync(), false);
  store.mergeRemote(remote);
  assert.equal(store.getSnapshot().draft, null);
  store.change('my next edit', hash);
  store.mergeRemote({ ...remote, content: 'another device', updatedAt: 124 });
  assert.equal(store.getSnapshot().draft?.content, 'my next edit');
  assert.equal(store.getSnapshot().conflict?.content, 'another device');
  assert.equal(await store.sync(), false);
  store.adoptRemote();
  assert.equal(store.getSnapshot().copy?.content, 'another device');
  assert.equal(store.getSnapshot().draft, null);
});
test('quota failures retain the draft and retry; logout invalidates late responses', async () => {
  reset();
  const store = documentStore(identity);
  full = true;
  assert.equal(store.change('unsaved', hash), false);
  assert.equal(await store.saveLocal(), false);
  full = false;
  assert.ok(await store.saveLocal());
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started!: () => void;
  const sending = new Promise<void>((r) => {
    started = r;
  });
  globalThis.fetch = async () => {
    started();
    await gate;
    return Response.json({
      copy: { path: 'note.md', content: 'unsaved', baseHash: hash, updatedAt: 1 },
    });
  };
  const sync = store.sync();
  await sending;
  events.dispatchEvent(new Event('codesip:private-data-cleared'));
  memory.clear();
  release();
  assert.equal(await sync, false);
  assert.equal(memory.size, 0);
});
