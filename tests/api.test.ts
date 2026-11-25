import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './helpers/backend';
import { readArchive } from '../server/zip';
import { cleanPath, MAX_FILE } from '../server/paths';
import { zipSync, strToU8 } from 'fflate';
const origin = 'http://127.0.0.1:4318';
async function fixture() {
  const { app, store } = await buildApp({
    database: ':memory:',
    setupToken: 'test-setup-key-codesip',
    rateLimit: false,
  });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin },
    payload: {
      username: 'reader',
      password: 'strong-test-password',
      setupToken: 'test-setup-key-codesip',
    },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.cookies[0].name + '=' + setup.cookies[0].value;
  return { app, store, cookie, headers: { cookie, origin }, user: setup.json().user };
}
test('setup is protected; session login/logout and cross-origin writes', async (t) => {
  const { app, headers } = await fixture();
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/api/libraries' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/libraries',
        headers: { ...headers, origin: 'https://evil.invalid' },
        payload: { name: 'Bad', kind: 'code' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin }, payload: {} }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: { username: 'reader', password: 'wrong' },
      })
    ).statusCode,
    401,
  );
  assert.equal((await app.inject({ url: '/api/session', headers })).json().user.username, 'reader');
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: '/api/session', headers })).statusCode, 401);
});
test('libraries isolate accounts, scoped plugin sync, conflicts, deletion and revocation', async (t) => {
  const { app, store, headers, user } = await fixture();
  t.after(() => app.close());
  const lib = (
    await app.inject({
      method: 'POST',
      url: '/api/libraries',
      headers,
      payload: { name: '中文笔记', kind: 'notes' },
    })
  ).json().library;
  const other = await store.createUser('other', 'other-test-password');
  const hidden = store.createLibrary(other.id, 'private', 'notes');
  const stolen = await app.inject({ url: `/api/libraries/${hidden.id}/manifest`, headers });
  assert.equal(stolen.statusCode, 404);
  const token = (
    await app.inject({ method: 'POST', url: `/api/libraries/${lib.id}/token`, headers })
  ).json().token;
  const bearer = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ url: '/api/libraries', headers: bearer })).statusCode, 403);
  assert.equal(
    (await app.inject({ url: `/api/libraries/${hidden.id}/manifest`, headers: bearer })).statusCode,
    403,
  );
  const sync = async (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/libraries/${lib.id}/sync`,
      headers: bearer,
      payload: body,
    });
  const content = Buffer.from('# 笔记\n读懂函数').toString('base64');
  assert.equal(
    (await sync({ baseRevision: 0, upserts: [{ path: '学习/代码.md', content }], deleted: [] }))
      .statusCode,
    200,
  );
  assert.equal(
    (await sync({ baseRevision: 0, upserts: [], deleted: ['学习/代码.md'] })).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/libraries/${lib.id}/file?path=${encodeURIComponent('学习/代码.md')}`,
        headers,
      })
    ).body,
    '# 笔记\n读懂函数',
  );
  assert.equal(
    (await app.inject({ url: `/api/libraries/${lib.id}/file?path=x`, headers: bearer })).statusCode,
    403,
  );
  const search = await app.inject({
    url: `/api/libraries/${lib.id}/search?q=${encodeURIComponent('函数')}`,
    headers,
  });
  assert.equal(search.json().results[0].line, 2);
  assert.equal(
    (await sync({ baseRevision: 1, upserts: [{ path: '../escape', content }], deleted: [] }))
      .statusCode,
    400,
  );
  assert.equal(store.manifest(user.id, lib.id).library.revision, 1);
  assert.equal(
    (await sync({ baseRevision: 1, upserts: [{ path: 'x', content: 'invalid!' }], deleted: [] }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await sync({
        baseRevision: 1,
        upserts: [{ path: '学习/改名.md', content }],
        deleted: ['学习/代码.md'],
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(
    store.manifest(user.id, lib.id).files.map((f) => f.path),
    ['学习/改名.md'],
  );
  await app.inject({ method: 'DELETE', url: `/api/libraries/${lib.id}/token`, headers });
  assert.equal((await sync({ baseRevision: 2, upserts: [], deleted: [] })).statusCode, 401);
});
test('archive import retains text and binary, ignores metadata and strips common root', async (t) => {
  const { app, headers, store, user } = await fixture();
  t.after(() => app.close());
  const buffer = Buffer.from(
    zipSync({
      'project/src/main.ts': strToU8('export const answer = 42;'),
      'project/assets/test.png': new Uint8Array([137, 80, 78, 71, 0, 1]),
      'project/.git/config': strToU8('private'),
      'project/.env': strToU8('private'),
    }),
  );
  const boundary = 'codesiptestboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="project.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({
    method: 'POST',
    url: '/api/import?kind=code&name=Sample',
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  const lib = response.json().library;
  const manifest = store.manifest(user.id, lib.id);
  assert.deepEqual(
    manifest.files.map((f) => f.path),
    ['assets/test.png', 'src/main.ts'],
  );
  assert.equal(manifest.files[0].isText, false);
  assert.equal(
    (await app.inject({ url: `/api/libraries/${lib.id}/file?path=src/main.ts`, headers })).body,
    'export const answer = 42;',
  );
});
test('reject ZIP traversal, oversized decompression, invalid paths and preserve revisions on failed batch', async (t) => {
  const { store, app, user } = await fixture();
  t.after(() => app.close());
  for (const value of ['../x', '/x', 'a\\b', 'a//b', 'a/./b', 'C:/x', 'x\0y'])
    assert.throws(() => cleanPath(value));
  await assert.rejects(readArchive(Buffer.from(zipSync({ '../escape.ts': strToU8('bad') }))));
  await assert.rejects(
    readArchive(Buffer.from(zipSync({ 'big.txt': new Uint8Array(MAX_FILE + 1) }))),
  );
  await assert.rejects(readArchive(Buffer.from('not zip')));
  const lib = store.createLibrary(user.id, 'Notes', 'notes');
  store.put(lib.id, [{ path: 'keep.md', bytes: Buffer.from('keep') }], [], 0);
  assert.throws(() =>
    store.put(lib.id, [{ path: 'big', bytes: Buffer.alloc(MAX_FILE + 1) }], ['keep.md'], 1),
  );
  assert.equal(store.file(user.id, lib.id, 'keep.md').size, 4);
  assert.equal(store.manifest(user.id, lib.id).library.revision, 1);
});
test('initial setup accepts exactly one concurrent creator', async (t) => {
  const { app, store } = await buildApp({
    database: ':memory:',
    setupToken: 'test-setup-key-codesip',
    rateLimit: false,
  });
  t.after(() => app.close());
  const requests = await Promise.all(
    ['first', 'second'].map((username) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { origin },
        payload: {
          username,
          password: 'long-enough-password',
          setupToken: 'test-setup-key-codesip',
        },
      }),
    ),
  );
  assert.deepEqual(requests.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(store.needsSetup, false);
});
