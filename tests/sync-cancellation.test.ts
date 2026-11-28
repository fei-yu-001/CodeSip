import test from 'node:test';
import assert from 'node:assert/strict';
import { api, HttpError } from '../web/src/data/http';
import {
  cacheGeneration,
  invalidatePrivateData,
  onPrivateDataCleared,
  sessionSignal,
} from '../web/src/data/session';
import { readerKey } from '../web/src/readerIdentity';
import type { Annotation } from '../web/src/annotationSync';
class MemoryStorage implements Storage {
  [key: string]: any;
  get length() {
    return Object.keys(this).length;
  }
  getItem(key: string) {
    return Object.hasOwn(this, key) ? (this[key] as string) : null;
  }
  setItem(key: string, value: string) {
    this[key] = String(value);
  }
  removeItem(key: string) {
    delete this[key];
  }
  clear() {
    for (const key of Object.keys(this)) delete this[key];
  }
  key(index: number) {
    return Object.keys(this)[index] ?? null;
  }
}
const storage = new MemoryStorage();
const events = new EventTarget();
Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
const { annotationStore, syncLibraryAnnotations } = await import('../web/src/annotationSync');
const { documentStore, syncLibraryDocumentCopies } = await import('../web/src/documentStore');
const nativeFetch = globalThis.fetch;
const identity = { userId: 'owner', libraryId: 'project', path: 'synthetic.md' };
const annotation = (id: string): Annotation => ({
  id,
  line: 1,
  snippet: '合成原文',
  note: id,
  createdAt: 1,
  localRev: 1,
  syncStatus: 'pending',
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test.afterEach(() => {
  invalidatePrivateData();
  storage.clear();
  globalThis.fetch = nativeFetch;
});
test('canceling annotation upload aborts the request, keeps uncertain drafts and skips the next item', async () => {
  const store = annotationStore(readerKey('annotations', identity), identity, () => {});
  for (const item of [annotation('a'), annotation('b')])
    store.persist([item], { type: 'save', item });
  const started = gate();
  const controller = new AbortController();
  let requests = 0,
    requestSignal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    requests++;
    requestSignal = init?.signal as AbortSignal;
    started.resolve();
    return new Promise((_resolve, reject) =>
      requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true }),
    );
  };
  const operation = syncLibraryAnnotations(identity.userId, identity.libraryId, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(requestSignal?.aborted, true);
  assert.equal(requests, 1);
  assert.equal(store.getSnapshot().annotations.length, 2);
  assert.ok(store.getSnapshot().annotations.every((item) => item.syncStatus === 'pending'));
  assert.equal(store.getSnapshot().annotations[0].attempted, true);
  // The queue is usable on retry after a canceled operation.
  globalThis.fetch = async (_url, init) => {
    const data = JSON.parse(String(init?.body));
    return Response.json({ annotation: { ...data, id: data.note, createdAt: 1, updatedAt: 2 } });
  };
  await syncLibraryAnnotations(identity.userId, identity.libraryId, new AbortController().signal);
  assert.ok(store.getSnapshot().annotations.every((item) => item.syncStatus === 'synced'));
});
test('a late annotation response after cancellation cannot clear a pending draft', async () => {
  const store = annotationStore(readerKey('annotations', identity), identity, () => {});
  const item = annotation('a');
  store.persist([item], { type: 'save', item });
  const controller = new AbortController();
  globalThis.fetch = async () => {
    controller.abort();
    return Response.json({ annotation: { ...item, updatedAt: 2 } });
  };
  await assert.rejects(store.sync(controller.signal), { name: 'AbortError' });
  assert.equal(store.getSnapshot().annotations[0].syncStatus, 'pending');
});
test('canceling a document upload preserves newer edits and prevents subsequent file uploads', async () => {
  const first = documentStore(identity);
  const other = documentStore({ ...identity, path: 'second.md' });
  first.change('first draft', 'a'.repeat(64));
  other.change('other draft', 'b'.repeat(64));
  const controller = new AbortController();
  const started = gate(),
    release = gate();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    started.resolve();
    await release.promise;
    return Response.json({
      copy: { path: identity.path, content: 'first draft', baseHash: 'a'.repeat(64), updatedAt: 2 },
    });
  };
  const operation = syncLibraryDocumentCopies(
    identity.userId,
    identity.libraryId,
    controller.signal,
  );
  await started.promise;
  first.change('newer draft while sending', 'a'.repeat(64));
  controller.abort();
  release.resolve();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(requests, 1);
  assert.equal(first.getSnapshot().draft?.content, 'newer draft while sending');
  assert.equal(other.getSnapshot().draft?.content, 'other draft');
  assert.equal(first.getSnapshot().busy, false);
});
test('401 while recovering a document conflict propagates to the global sync session', async () => {
  const store = documentStore(identity);
  store.change('local edit', 'a'.repeat(64));
  globalThis.fetch = async (_url, init) =>
    Response.json({ error: 'synthetic error' }, { status: init?.method === 'PUT' ? 409 : 401 });
  await assert.rejects(
    store.sync(undefined, new AbortController().signal),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
  assert.equal(store.getSnapshot().draft?.content, 'local edit');
  assert.equal(store.getSnapshot().busy, false);
});
test('session invalidation cancels old work before cleanup and creates an independent new lifetime', () => {
  const before = sessionSignal(),
    generation = cacheGeneration();
  let cleaned = false;
  const off = onPrivateDataCleared(() => {
    assert.equal(before.aborted, true);
    cleaned = true;
  });
  const bad = onPrivateDataCleared(() => {
    throw Error('one feature failed');
  });
  invalidatePrivateData();
  assert.equal(cleaned, true);
  assert.equal(cacheGeneration(), generation + 1);
  assert.notEqual(sessionSignal(), before);
  assert.equal(sessionSignal().aborted, false);
  off();
  bad();
});
test('a pre-canceled HTTP operation never makes a request', async () => {
  globalThis.fetch = async () => {
    assert.fail('canceled requests must not start');
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api('/synthetic', { signal: controller.signal }), { name: 'AbortError' });
});
