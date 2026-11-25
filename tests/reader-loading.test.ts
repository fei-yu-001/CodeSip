import assert from 'node:assert/strict';
import test from 'node:test';
import { createVaultImageLoader } from '../web/src/VaultImage';
// readerState registers browser lifecycle listeners at module initialization.
Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
const { writeCopyStateToStorage } = await import('../web/src/documentCopies');
import type { FileEntry, User } from '../shared/types';
const req = (hash: string, userId = 'a') => ({
  user: { id: userId } as User,
  libraryId: 'vault',
  offline: false,
  file: { hash, path: hash + '.png', mediaType: 'image/png' } as FileEntry,
});
test('cancelling an in-flight image releases its slot and queued images still finish', async () => {
  const starts: string[] = [];
  const loader = createVaultImageLoader({
    maxConcurrency: 1,
    fetchBlob: async (_user, _id, file, _network, signal) => {
      starts.push(file.hash);
      if (file.hash === 'a')
        await new Promise((_resolve, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason)),
        );
      return new Blob(['verified']);
    },
  });
  const a = loader.load(req('a'));
  const b = loader.load(req('b'));
  const rejected = assert.rejects(a.promise, { name: 'AbortError' });
  a.cancel();
  await rejected;
  assert.equal(await (await b.promise).text(), 'verified');
  assert.deepEqual(starts, ['a', 'b']);
  assert.equal(loader.stats().active, 0);
});
test('image cache deduplicates, isolates accounts, caps memory and ignores late completion after clear', async () => {
  let calls = 0;
  let finish: ((blob: Blob) => void) | undefined;
  const loader = createVaultImageLoader({
    maxBytes: 8,
    maxEntryBytes: 8,
    fetchBlob: async (_user, _id, file) => {
      calls++;
      if (file.hash === 'late')
        return new Promise<Blob>((resolve) => {
          finish = resolve;
        });
      return new Blob(['12345']);
    },
  });
  const a = loader.load(req('x'));
  const b = loader.load(req('x'));
  await Promise.all([a.promise, b.promise]);
  assert.equal(calls, 1);
  await loader.load(req('x', 'other')).promise;
  assert.equal(calls, 2);
  assert.equal(loader.stats().entries, 1);
  assert.equal(loader.stats().bytes, 5);
  const late = loader.load(req('late'));
  const rejected = assert.rejects(late.promise, { name: 'AbortError' });
  loader.clear();
  finish!(new Blob(['12345']));
  await rejected;
  await Promise.resolve();
  assert.equal(loader.stats().entries, 0);
});
test('identical drafts retry storage after quota errors instead of reporting a false success', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let full = true;
  let writes = 0;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      setItem() {
        writes++;
        if (full) throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem() {},
    },
  });
  try {
    const state = {
      copy: null,
      draft: { content: 'draft', baseHash: 'a'.repeat(64), expectedUpdatedAt: null },
    };
    assert.deepEqual(writeCopyStateToStorage('key', state, state, true), {
      changed: false,
      ok: false,
    });
    full = false;
    assert.deepEqual(writeCopyStateToStorage('key', state, state, true), {
      changed: false,
      ok: true,
    });
    assert.equal(writes, 2);
    writeCopyStateToStorage('key', state, state, false);
    assert.equal(writes, 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
