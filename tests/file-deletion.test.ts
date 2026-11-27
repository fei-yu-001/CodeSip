import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './helpers/backend';
import { digest } from '../server/store';

const origin = 'http://127.0.0.1:4318';
async function fixture(kind: 'notes' | 'code' = 'notes') {
  const instance = await buildApp({
    database: ':memory:',
    setupToken: 'delete-test-setup',
    rateLimit: false,
  });
  const user = await instance.store.createUser('delete-reader', 'delete-test-password');
  const headers = { cookie: `codesip_session=${instance.store.session(user.id)}`, origin };
  const library = instance.store.createLibrary(user.id, '删除验证', kind);
  instance.store.put(
    library.id,
    [
      { path: '目录/多余 #1.md', bytes: Buffer.from('# Shared bytes') },
      { path: 'keep.md', bytes: Buffer.from('# Shared bytes') },
    ],
    [],
    0,
  );
  const url = `/api/libraries/${library.id}/file`;
  const payload = { path: '目录/多余 #1.md', baseRevision: 1 };
  return { ...instance, user, headers, library, url, payload };
}
for (const kind of ['notes', 'code'] as const) {
  test(`${kind} file deletion checks revisions, preserves other files and permits an empty project`, async (t) => {
    const { app, store, user, headers, library, url, payload } = await fixture(kind);
    t.after(() => app.close());
    for (const invalid of [
      { ...payload, baseRevision: -1 },
      { ...payload, path: '../keep.md' },
      { path: 'keep.md' },
      {},
    ]) {
      assert.equal(
        (await app.inject({ method: 'DELETE', url, headers, payload: invalid })).statusCode,
        400,
      );
    }
    const stale = await app.inject({
      method: 'DELETE',
      url,
      headers,
      payload: { ...payload, baseRevision: 0 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(store.manifest(user.id, library.id).files.length, 2);
    const result = await app.inject({ method: 'DELETE', url, headers, payload });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(
      result.json().files.map((f: { path: string }) => f.path),
      ['keep.md'],
    );
    assert.equal(result.json().library.revision, 2);
    assert.equal(result.json().library.fileCount, 1);
    assert.equal(
      Buffer.from(store.file(user.id, library.id, 'keep.md').content).toString(),
      '# Shared bytes',
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers,
          payload: { ...payload, baseRevision: 2 },
        })
      ).statusCode,
      404,
    );
    assert.equal(store.manifest(user.id, library.id).library.revision, 2);
    const last = await app.inject({
      method: 'DELETE',
      url,
      headers,
      payload: { path: 'keep.md', baseRevision: 2 },
    });
    assert.equal(last.statusCode, 200, last.body);
    assert.deepEqual(last.json().files, []);
    assert.equal(last.json().library.totalBytes, 0);
    assert.equal(last.json().library.id, library.id);
    assert.equal(last.json().library.revision, 3);
  });
}

test('file deletion isolates accounts and sessions, preserves reader work and supports reimport', async (t) => {
  const { app, store, user, headers, library, url, payload } = await fixture();
  t.after(() => app.close());
  const other = await store.createUser('delete-other', 'other-delete-password');
  const token = store.issueToken(user.id, library.id);
  for (const [credentials, status] of [
    [{ origin }, 401],
    [{ origin, cookie: `codesip_session=${store.session(other.id)}` }, 404],
    [{ origin, authorization: `Bearer ${token}` }, 403],
    [{ ...headers, origin: 'https://foreign.invalid' }, 403],
  ] as const) {
    assert.equal(
      (await app.inject({ method: 'DELETE', url, headers: credentials, payload })).statusCode,
      status,
    );
  }
  const copyUrl = `/api/libraries/${library.id}/document-copy`;
  const copy = await app.inject({
    method: 'PUT',
    url: copyUrl,
    headers,
    payload: {
      path: payload.path,
      content: '# My work',
      baseHash: digest('# Shared bytes'),
      expectedUpdatedAt: null,
    },
  });
  assert.equal(copy.statusCode, 200, copy.body);
  const annotation = await app.inject({
    method: 'PUT',
    url: `/api/libraries/${library.id}/annotations/delete-test-annotation`,
    headers,
    payload: {
      path: payload.path,
      line: 1,
      snippet: 'Shared bytes',
      note: 'Keep this thought',
      expectedUpdatedAt: null,
    },
  });
  assert.equal(annotation.statusCode, 200, annotation.body);
  assert.equal((await app.inject({ method: 'DELETE', url, headers, payload })).statusCode, 200);
  const query = encodeURIComponent(payload.path);
  const savedCopy = await app.inject({ url: `${copyUrl}?path=${query}`, headers });
  assert.equal(savedCopy.statusCode, 200, savedCopy.body);
  assert.equal(savedCopy.json().copy.content, '# My work');
  const savedAnnotations = await app.inject({
    url: `/api/libraries/${library.id}/annotations?path=${query}`,
    headers,
  });
  assert.equal(savedAnnotations.statusCode, 200, savedAnnotations.body);
  assert.equal(savedAnnotations.json().annotations[0].note, 'Keep this thought');
  const reimport = await app.inject({
    method: 'POST',
    url: `/api/libraries/${library.id}/sync`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      baseRevision: 2,
      deleted: [],
      upserts: [
        { path: payload.path, content: Buffer.from('# Restored by source').toString('base64') },
      ],
    },
  });
  assert.equal(reimport.statusCode, 200, reimport.body);
  assert.equal(store.manifest(user.id, library.id).files.length, 2);
});
