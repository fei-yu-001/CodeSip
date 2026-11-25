import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './helpers/backend';
import { digest } from '../server/store';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const origin = 'http://127.0.0.1:4318';
async function fixture(database = ':memory:') {
  const instance = await buildApp({
    database,
    setupToken: 'document-test-key',
    rateLimit: false,
  });
  await instance.app.ready();
  const user = await instance.store.createUser('copy-reader', 'reading-copy-password');
  const headers = { cookie: `codesip_session=${instance.store.session(user.id)}`, origin };
  const lib = instance.store.createLibrary(user.id, '阅读笔记', 'notes');
  instance.store.sync(user.id, lib.id, {
    baseRevision: 0,
    deleted: [],
    upserts: [{ path: 'note.md', content: Buffer.from('# 电脑原文').toString('base64') }],
  });
  const url = `/api/libraries/${lib.id}/document-copy`;
  const draft = {
    path: 'note.md',
    content: '# 我的编辑版',
    baseHash: digest('# 电脑原文'),
    expectedUpdatedAt: null,
  };
  return { ...instance, user, lib, headers, url, draft };
}

test('reading copies preserve source and revision, survive plugin updates and detect stale writes with idempotent retries', async (t) => {
  const { app, store, user, lib, headers, url, draft } = await fixture();
  t.after(() => app.close());
  const before = store.manifest(user.id, lib.id);
  const first = await app.inject({ method: 'PUT', url, headers, payload: draft });
  assert.equal(first.statusCode, 200, first.body);
  const copy = first.json().copy;
  assert.deepEqual(store.manifest(user.id, lib.id), before);
  assert.equal(
    Buffer.from(store.file(user.id, lib.id, 'note.md').content).toString(),
    '# 电脑原文',
  );
  const retry = await app.inject({ method: 'PUT', url, headers, payload: draft });
  assert.deepEqual(retry.json().copy, copy);
  const second = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { ...draft, content: '# 新的编辑', expectedUpdatedAt: copy.updatedAt },
  });
  assert.equal(second.statusCode, 200);
  assert.ok(second.json().copy.updatedAt > copy.updatedAt);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers,
        payload: { ...draft, content: '# 过期草稿', expectedUpdatedAt: copy.updatedAt },
      })
    ).statusCode,
    409,
  );
  store.sync(user.id, lib.id, {
    baseRevision: before.library.revision,
    deleted: [],
    upserts: [{ path: 'note.md', content: Buffer.from('# 电脑更新').toString('base64') }],
  });
  const otherSession = { ...headers, cookie: `codesip_session=${store.session(user.id)}` };
  const get = await app.inject({ url: `${url}?path=note.md`, headers: otherSession });
  assert.deepEqual(get.json().copy, second.json().copy);
  store.sync(user.id, lib.id, {
    baseRevision: before.library.revision + 1,
    deleted: ['note.md'],
    upserts: [],
  });
  assert.deepEqual(
    (await app.inject({ url: `${url}?path=note.md`, headers })).json().copy,
    second.json().copy,
  );
});

test('reading-copy routes isolate accounts and reject plugin tokens, unauthenticated access and cross-origin writes', async (t) => {
  const { app, store, user, lib, headers, url, draft } = await fixture();
  t.after(() => app.close());
  const other = await store.createUser('copy-other', 'another-reading-password');
  const foreign = { ...headers, cookie: `codesip_session=${store.session(other.id)}` };
  const plugin = { origin, authorization: `Bearer ${store.issueToken(user.id, lib.id)}` };
  for (const method of ['GET', 'PUT'] as const) {
    const target = method === 'GET' ? `${url}?path=note.md` : url;
    const payload = method === 'PUT' ? draft : undefined;
    for (const [credentials, status] of [
      [foreign, 404],
      [plugin, 403],
      [{ origin }, 401],
    ] as const)
      assert.equal(
        (await app.inject({ method, url: target, headers: credentials, payload })).statusCode,
        status,
      );
  }
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers: { ...headers, origin: 'https://foreign.invalid' },
        payload: draft,
      })
    ).statusCode,
    403,
  );
  assert.equal((await app.inject({ url: `${url}?path=note.md`, headers })).json().copy, null);
});

test('reading copies validate paths, size, type and versions and refuse to edit imported code', async (t) => {
  const { app, store, user, headers, url, draft } = await fixture();
  t.after(() => app.close());
  for (const invalid of [
    { path: '../note.md' },
    { path: '' },
    { path: 'image.png' },
    { content: 42 },
    { content: 'x'.repeat(500001) },
    { baseHash: '' },
    { expectedUpdatedAt: -1 },
    { expectedUpdatedAt: 1.5 },
    { expectedUpdatedAt: 'wrong' },
  ]) {
    const response = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { ...draft, ...invalid },
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(
    (await app.inject({ method: 'PUT', url, headers, payload: { ...draft, path: 'missing.md' } }))
      .statusCode,
    404,
  );
  const code = store.createLibrary(user.id, '代码', 'code');
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/libraries/${code.id}/document-copy`,
        headers,
        payload: draft,
      })
    ).statusCode,
    400,
  );
  const empty = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { ...draft, content: '' },
  });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().copy.content, '');
});

test('reading copies persist across a server restart without changing the existing library', async (t) => {
  const local = path.resolve('.local');
  mkdirSync(local, { recursive: true });
  const directory = mkdtempSync(path.join(local, 'document-copy-'));
  let running: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    await running?.app.close();
    assert.equal(path.dirname(path.resolve(directory)), local);
    rmSync(directory, { recursive: true, force: true });
  });
  const database = path.join(directory, 'reader.sqlite');
  const first = await fixture(database);
  running = first;
  const response = await first.app.inject({
    method: 'PUT',
    url: first.url,
    headers: first.headers,
    payload: first.draft,
  });
  assert.equal(response.statusCode, 200);
  const before = first.store.manifest(first.user.id, first.lib.id);
  await running.app.close();
  running = undefined;
  running = await buildApp({ database, setupToken: 'document-test-key', rateLimit: false });
  await running.app.ready();
  const responseAfter = await running.app.inject({
    url: first.url + '?path=note.md',
    headers: first.headers,
  });
  assert.equal(responseAfter.statusCode, 200);
  assert.deepEqual(responseAfter.json(), response.json());
  assert.deepEqual(running.store.manifest(first.user.id, first.lib.id), before);
});
