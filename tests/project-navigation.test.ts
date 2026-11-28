import test from 'node:test';
import assert from 'node:assert/strict';
import type { Manifest, User } from '../shared/types';
import { HttpError, manifestKey } from '../web/src/api';
import {
  loadProjectManifest,
  ProjectManifestMismatchError,
  ProjectOfflineUnavailableError,
  readProjectRoute,
} from '../web/src/projectNavigation';

const user: User = { id: 'user-a', username: 'reader-a' };
const otherUser: User = { id: 'user-b', username: 'reader-b' };
const libraryId = 'project-a';
const manifest: Manifest = {
  library: {
    id: libraryId,
    name: 'Synthetic project',
    kind: 'code',
    revision: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
    fileCount: 1,
    totalBytes: 12,
  },
  files: [
    { path: 'README.md', hash: 'a'.repeat(64), size: 12, isText: true, mediaType: 'text/markdown' },
  ],
};

test('normalizes a leading route slash and preserves decoded query punctuation', () => {
  assert.deepEqual(
    readProjectRoute('#/notes/project-a?file=docs%2Fwhat%3F.md&line=4.8&heading=Start%3FNow'),
    {
      kind: 'notes',
      id: 'project-a',
      file: 'docs/what?.md',
      line: 4,
      heading: 'Start?Now',
    },
  );
  assert.deepEqual(readProjectRoute('#code/project-a?line=Infinity'), {
    kind: 'code',
    id: 'project-a',
    file: undefined,
    line: 1,
    heading: undefined,
  });
});

test('returns a matching cached manifest first without contacting the server', async () => {
  let networkCalls = 0;
  const result = await loadProjectManifest({
    user,
    libraryId,
    online: true,
    readCache: async () => manifest,
    fetchManifest: async () => {
      networkCalls++;
      return manifest;
    },
  });

  assert.equal(result.manifest, manifest);
  assert.equal(result.source, 'cache');
  assert.equal(networkCalls, 0);
});

test('fetches and returns the manifest only when the matching cache is absent', async () => {
  let requested = '';
  const result = await loadProjectManifest({
    user,
    libraryId,
    online: true,
    readCache: async () => undefined,
    fetchManifest: async (url) => {
      requested = url;
      return manifest;
    },
  });

  assert.equal(requested, '/libraries/project-a/manifest');
  assert.equal(result.manifest, manifest);
  assert.equal(result.source, 'network');
});

test('propagates a server 404 when no cached project exists', async () => {
  await assert.rejects(
    loadProjectManifest({
      user,
      libraryId,
      online: true,
      readCache: async () => undefined,
      fetchManifest: async () => {
        throw new HttpError(404, '找不到这个项目');
      },
    }),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
});

test('uses only the current user and project cache while offline', async () => {
  const keys: string[] = [];
  const result = await loadProjectManifest({
    user: otherUser,
    libraryId,
    online: false,
    readCache: async (key) => {
      keys.push(key);
      return manifest;
    },
  });

  assert.equal(result.manifest, manifest);
  assert.equal(result.source, 'cache');
  assert.deepEqual(keys, [manifestKey(otherUser, libraryId)]);
});

test('does not treat a different account cache as the current account project', async () => {
  const keys: string[] = [];
  await assert.rejects(
    loadProjectManifest({
      user: otherUser,
      libraryId,
      online: false,
      readCache: async (key) => {
        keys.push(key);
        return key === manifestKey(user, libraryId) ? manifest : undefined;
      },
      fetchManifest: async () => {
        throw new TypeError('Network unavailable');
      },
    }),
    ProjectOfflineUnavailableError,
  );
  assert.deepEqual(keys, [manifestKey(otherUser, libraryId)]);
});

test('ignores a cached manifest with a different project id', async () => {
  const wrongProject = {
    ...manifest,
    library: { ...manifest.library, id: 'different-project' },
  };
  await assert.rejects(
    loadProjectManifest({
      user,
      libraryId,
      online: false,
      readCache: async () => wrongProject,
      fetchManifest: async () => {
        throw new TypeError('Network unavailable');
      },
    }),
    ProjectOfflineUnavailableError,
  );
});

test('rejects a mismatched server manifest without writing it to the cache', async () => {
  const wrongProject = {
    ...manifest,
    library: { ...manifest.library, id: 'different-project' },
  };
  await assert.rejects(
    loadProjectManifest({
      user,
      libraryId,
      online: true,
      readCache: async () => undefined,
      fetchManifest: async () => wrongProject,
    }),
    ProjectManifestMismatchError,
  );
});

test('allows an uncached offline project to fail explicitly without redirecting', async () => {
  await assert.rejects(
    loadProjectManifest({
      user,
      libraryId,
      online: false,
      readCache: async () => undefined,
      fetchManifest: async () => {
        throw new TypeError('Network unavailable');
      },
    }),
    ProjectOfflineUnavailableError,
  );
});

test('attempts an explicit open when the WebView reports offline but HTTP works', async () => {
  let calls = 0;
  const result = await loadProjectManifest({
    user,
    libraryId,
    online: false,
    readCache: async () => undefined,
    fetchManifest: async () => {
      calls++;
      return manifest;
    },
  });
  assert.equal(result.manifest, manifest);
  assert.equal(result.source, 'network');
  assert.equal(calls, 1);
});

test('preserves authentication errors even when the WebView reports offline', async () => {
  await assert.rejects(
    loadProjectManifest({
      user,
      libraryId,
      online: false,
      readCache: async () => undefined,
      fetchManifest: async () => {
        throw new HttpError(401, '请重新登录');
      },
    }),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
});
