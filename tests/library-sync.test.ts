import test from 'node:test';
import assert from 'node:assert/strict';
import type { Library, User } from '../shared/types';
import { HttpError } from '../web/src/data/http';
import {
  runLibrarySync,
  syncResultMessage,
  type LibrarySyncPorts,
} from '../web/src/sync/librarySync';
const user: User = { id: 'owner', username: 'reader' };
const library = (id: string, revision = 2): Library => ({
  id,
  name: `项目 ${id}`,
  kind: 'code',
  revision,
  updatedAt: '2026-11-28T00:00:00.000Z',
  fileCount: 1,
  totalBytes: 10,
});
function fixture() {
  const calls: string[] = [];
  const published: { libraries: Library[]; complete: boolean }[] = [];
  const controller = new AbortController();
  const ports: LibrarySyncPorts = {
    authenticate: async () => user,
    list: async () => [library('a'), library('b')],
    localLibraries: async () => [library('a', 1), library('b', 1), library('local', 1)],
    saved: async () => true,
    pendingLibraries: () => [],
    manifest: async (id) => {
      calls.push(`${id}:manifest`);
      return { library: library(id), files: [] };
    },
    annotations: async (id) => {
      calls.push(`${id}:annotations`);
    },
    documents: async (id) => {
      calls.push(`${id}:documents`);
    },
    readerState: async (id) => {
      calls.push(`${id}:state`);
      return { annotations: [], copies: [] };
    },
    mergeAnnotations: (id) => {
      calls.push(`${id}:merge-annotations`);
    },
    mergeDocuments: (id) => {
      calls.push(`${id}:merge-documents`);
    },
    markSnapshot: (id) => {
      calls.push(`${id}:snapshot`);
    },
    files: async (manifest) => {
      calls.push(`${manifest.library.id}:files`);
    },
    publish: async (libraries, complete) => {
      published.push({ libraries, complete });
    },
    pending: () => 0,
  };
  const run = (options: { currentId?: string; onlyIds?: string[] } = {}) =>
    runLibrarySync({ user, ports, signal: controller.signal, progress: () => {}, ...options });
  return { calls, published, controller, ports, run };
}
test('a file failure preserves its old revision while later projects complete', async () => {
  const f = fixture();
  f.ports.files = async (manifest) => {
    f.calls.push(`${manifest.library.id}:files`);
    if (manifest.library.id === 'a') throw Error('download interrupted');
  };
  const result = await f.run();
  assert.deepEqual(
    result.failures.map((failure) => [failure.libraryId, failure.stage]),
    [['a', 'files']],
  );
  assert.ok(f.calls.includes('b:files'));
  assert.deepEqual(
    result.libraries.map(({ id, revision }) => [id, revision]),
    [
      ['a', 1],
      ['b', 2],
      ['local', 1],
    ],
  );
  assert.equal(f.published[0].complete, false);
  assert.equal(result.localOnly, 1);
  assert.match(syncResultMessage(result), /1 个项目完成，1 个项目仍待处理/);
});
test('annotation failures do not skip document uploads, reader state or files', async () => {
  const f = fixture();
  f.ports.annotations = async (id) => {
    if (id === 'a') throw Error('conflict kept locally');
  };
  const result = await f.run();
  assert.equal(result.failures[0].stage, 'annotations');
  for (const call of ['a:documents', 'a:state', 'a:files', 'b:files'])
    assert.ok(f.calls.includes(call), call);
  assert.equal(result.libraries[0].revision, 2);
});
test('a manifest failure still allows independent annotation and document uploads', async () => {
  const f = fixture();
  f.ports.manifest = async (id) => {
    if (id === 'a') throw Error('manifest unavailable');
    return { library: library(id), files: [] };
  };
  const result = await f.run();
  assert.equal(result.failures[0].stage, 'manifest');
  assert.ok(f.calls.includes('a:annotations'));
  assert.ok(f.calls.includes('a:documents'));
  assert.ok(!f.calls.includes('a:files'));
  assert.ok(f.calls.includes('b:files'));
  assert.equal(result.libraries[0].revision, 1);
});
test('a mismatched manifest never downloads into a different project', async () => {
  const f = fixture();
  f.ports.manifest = async () => ({ library: library('wrong'), files: [] });
  const result = await f.run();
  assert.equal(result.failures.length, 2);
  assert.ok(!f.calls.some((call) => call.endsWith(':files')));
});
test('reader state merge failure does not mark a complete snapshot or skip files', async () => {
  const f = fixture();
  f.ports.mergeAnnotations = (id) => {
    if (id === 'a') throw Error('storage full');
  };
  const result = await f.run();
  assert.equal(result.failures[0].stage, 'annotations');
  assert.ok(f.calls.includes('a:merge-documents'));
  assert.ok(!f.calls.includes('a:snapshot'));
  assert.ok(f.calls.includes('a:files'));
});
test('retry selects only failed projects without reuploading the completed ones', async () => {
  const f = fixture();
  const result = await f.run({ onlyIds: ['b'] });
  assert.deepEqual(
    result.projects.map((project) => project.libraryId),
    ['b'],
  );
  assert.ok(f.calls.every((call) => call.startsWith('b:')));
  assert.equal(f.published[0].complete, true);
});
test('current project runs first and pending projects remain eligible', async () => {
  const f = fixture();
  f.ports.pendingLibraries = () => ['a'];
  const result = await f.run({ currentId: 'b' });
  assert.deepEqual(
    result.projects.map((project) => project.libraryId),
    ['b', 'a'],
  );
  assert.equal(f.calls[0], 'b:manifest');
});
test('401 during a feature stops remaining work and never publishes a success', async () => {
  const f = fixture();
  f.ports.annotations = async () => {
    throw new HttpError(401, 'expired');
  };
  await assert.rejects(
    f.run(),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
  assert.ok(!f.calls.includes('a:documents'));
  assert.ok(!f.calls.includes('b:manifest'));
  assert.equal(f.published.length, 0);
});
test('account mismatch stops before loading libraries', async () => {
  const f = fixture();
  f.ports.authenticate = async () => ({ ...user, id: 'someone-else' });
  f.ports.list = async () => {
    assert.fail('must not read another account');
  };
  await assert.rejects(
    f.run(),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
});
test('cancellation stops work even when an adapter returns a late success', async () => {
  const f = fixture();
  f.ports.documents = async (_id, signal) => {
    assert.equal(signal, f.controller.signal);
    f.controller.abort();
  };
  await assert.rejects(f.run(), { name: 'AbortError' });
  assert.ok(!f.calls.includes('a:state'));
  assert.ok(!f.calls.includes('b:manifest'));
  assert.equal(f.published.length, 0);
});
test('successful runs report pending drafts and retain remotely removed archives', async () => {
  const f = fixture();
  f.ports.pending = () => 2;
  const result = await f.run();
  assert.equal(result.failures.length, 0);
  assert.equal(f.published[0].complete, true);
  assert.match(syncResultMessage(result), /2 项本机修改仍待处理/);
  assert.match(syncResultMessage({ ...result, pending: 0 }), /1 个云端已移除的项目保留在本机/);
});

test('publication uses the downloaded revision if the project changed after listing', async () => {
  const f = fixture();
  f.ports.manifest = async (id) => ({ library: library(id, 3), files: [] });
  const result = await f.run();
  assert.deepEqual(
    result.libraries.slice(0, 2).map((library) => library.revision),
    [3, 3],
  );
  assert.equal(f.published[0].libraries[0].revision, 3);
});
