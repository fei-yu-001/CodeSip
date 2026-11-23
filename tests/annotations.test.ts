import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server/app';
import { readArchive } from '../server/zip';
import { zipSync, strToU8 } from 'fflate';
import { MAX_ANNOTATIONS_PER_FILE } from '../server/annotations';

const origin = 'http://127.0.0.1:4318';
async function fixture(database = ':memory:', staticDir?: string) {
  const instance = await buildApp({
    database,
    setupToken: 'annotations-test-setup-key',
    rateLimit: false,
    staticDir,
  });
  await instance.app.ready();
  const user = await instance.store.createUser('annotations', 'annotations-test-password');
  const headers = { cookie: `codesip_session=${instance.store.session(user.id)}`, origin };
  const lib = instance.store.createLibrary(user.id, '笔记', 'notes');
  instance.store.sync(user.id, lib.id, {
    baseRevision: 0,
    deleted: [],
    upserts: [
      { path: '目录/学习.md', content: Buffer.from('# 只读原文\n\n学习段落').toString('base64') },
      { path: 'other.md', content: Buffer.from('# 同库的其他笔记').toString('base64') },
    ],
  });
  const url = `/api/libraries/${lib.id}/annotations`;
  return { ...instance, headers, user, lib, url };
}
const draft = {
  path: '目录/学习.md',
  line: 3,
  snippet: '学习段落',
  note: '我的理解',
  expectedUpdatedAt: null,
};

test('annotations persist across restart and device sessions without modifying source or revision', async (t) => {
  const local = path.resolve('.local');
  mkdirSync(local, { recursive: true });
  const temporary = mkdtempSync(path.join(local, 'annotation-test-'));
  const database = path.join(temporary, 'reader.sqlite');
  let running: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    await running?.app.close();
    assert.equal(path.dirname(path.resolve(temporary)), local);
    rmSync(temporary, { recursive: true, force: true });
  });
  const first = await fixture(database);
  running = first;
  const before = first.store.manifest(first.user.id, first.lib.id);
  const response = await first.app.inject({
    method: 'PUT',
    url: first.url + '/note-1',
    headers: first.headers,
    payload: draft,
  });
  assert.equal(response.statusCode, 200, response.body);
  const saved = response.json().annotation;
  assert.equal(saved.note, draft.note);
  assert.ok(saved.updatedAt > 0);
  assert.equal(saved.createdAt, saved.updatedAt);
  const otherCookie = `codesip_session=${first.store.session(first.user.id)}`;
  const fromDevice = await first.app.inject({
    url: first.url + '?path=' + encodeURIComponent(draft.path),
    headers: { cookie: otherCookie },
  });
  assert.deepEqual(fromDevice.json().annotations, [saved]);
  assert.deepEqual(first.store.manifest(first.user.id, first.lib.id), before);
  assert.equal(
    Buffer.from(first.store.file(first.user.id, first.lib.id, draft.path).content).toString(),
    '# 只读原文\n\n学习段落',
  );
  await first.app.close();
  running = undefined;
  running = await buildApp({
    database,
    setupToken: 'annotations-test-setup-key',
    rateLimit: false,
  });
  const reopened = await running.app.inject({
    url: first.url + '?path=' + encodeURIComponent(draft.path),
    headers: first.headers,
  });
  assert.deepEqual(reopened.json().annotations, [saved]);
  const otherFile = await running.app.inject({
    url: first.url + '?path=other.md',
    headers: first.headers,
  });
  assert.deepEqual(otherFile.json().annotations, []);
});

test('annotation reads and writes isolate accounts and libraries and reject plugin access and cross-origin changes', async (t) => {
  const { app, store, headers, user, lib, url } = await fixture();
  t.after(() => app.close());
  const saved = await app.inject({
    method: 'PUT',
    url: url + '/shared-id',
    headers,
    payload: draft,
  });
  assert.equal(saved.statusCode, 200);
  const other = await store.createUser('other-reader', 'other-reader-password');
  const foreignHeaders = { cookie: `codesip_session=${store.session(other.id)}`, origin };
  const plugin = { authorization: `Bearer ${store.issueToken(user.id, lib.id)}` };
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const target =
      method === 'GET' ? url + '?path=' + encodeURIComponent(draft.path) : url + '/shared-id';
    const payload =
      method === 'PUT'
        ? draft
        : method === 'DELETE'
          ? { expectedUpdatedAt: saved.json().annotation.updatedAt }
          : undefined;
    assert.equal(
      (await app.inject({ method, url: target, headers: foreignHeaders, payload })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method, url: target, headers: plugin, payload })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method, url: target, headers: { origin }, payload })).statusCode,
      401,
    );
    if (method !== 'GET')
      assert.equal(
        (
          await app.inject({
            method,
            url: target,
            headers: { ...headers, origin: 'https://foreign.invalid' },
            payload,
          })
        ).statusCode,
        403,
      );
  }
  const second = store.createLibrary(user.id, 'another', 'code');
  store.put(
    second.id,
    await readArchive(
      Buffer.from(
        zipSync({ [draft.path]: strToU8('const a = 1;'), 'README.md': strToU8('# Code') }),
      ),
    ),
    [],
    0,
  );
  assert.deepEqual(
    (
      await app.inject({
        url: `/api/libraries/${second.id}/annotations?path=${encodeURIComponent(draft.path)}`,
        headers,
      })
    ).json().annotations,
    [],
  );
  const secondWrite = await app.inject({
    method: 'PUT',
    url: `/api/libraries/${second.id}/annotations/shared-id`,
    headers,
    payload: { ...draft, note: '另一个项目' },
  });
  assert.equal(secondWrite.statusCode, 200);
  assert.equal(
    (await app.inject({ url: url + '?path=' + encodeURIComponent(draft.path), headers })).json()
      .annotations[0].note,
    draft.note,
  );
});

test('concurrent annotation changes conflict, lost-response retries are idempotent and offline edits cannot resurrect deletion', async (t) => {
  const { app, headers, url } = await fixture();
  t.after(() => app.close());
  const target = url + '/concurrent';
  const write = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: target, headers, payload });
  const first = (await write(draft)).json().annotation;
  assert.deepEqual((await write(draft)).json().annotation, first);
  const [a, b] = await Promise.all([
    write({ ...draft, note: '设备 A', expectedUpdatedAt: first.updatedAt }),
    write({ ...draft, note: '设备 B', expectedUpdatedAt: first.updatedAt }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  const latest = (a.statusCode === 200 ? a : b).json().annotation;
  assert.ok(latest.updatedAt > first.updatedAt);
  assert.equal(latest.createdAt, first.createdAt);
  assert.deepEqual(
    (await write({ ...draft, note: latest.note, expectedUpdatedAt: first.updatedAt })).json()
      .annotation,
    latest,
  );
  assert.equal(
    (await write({ ...draft, path: 'other.md', expectedUpdatedAt: latest.updatedAt })).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: target,
        headers,
        payload: { expectedUpdatedAt: first.updatedAt },
      })
    ).statusCode,
    409,
  );
  const deletion = {
    method: 'DELETE' as const,
    url: target,
    headers,
    payload: { expectedUpdatedAt: latest.updatedAt },
  };
  assert.equal((await app.inject(deletion)).statusCode, 200);
  assert.equal((await app.inject(deletion)).statusCode, 200);
  assert.equal((await write(draft)).statusCode, 409);
  assert.equal((await write({ ...draft, expectedUpdatedAt: latest.updatedAt })).statusCode, 409);
  assert.deepEqual(
    (await app.inject({ url: url + '?path=' + encodeURIComponent(draft.path), headers })).json()
      .annotations,
    [],
  );
});

test('annotation validation rejects malformed and oversized input and enforces per-file limits', async (t) => {
  const { app, store, headers, lib, url } = await fixture();
  t.after(() => app.close());
  for (const patch of [
    { path: '../escape.md' },
    { path: '' },
    { line: 0 },
    { line: 1.5 },
    { line: '3' },
    { note: '' },
    { note: '   ' },
    { note: 'a'.repeat(10001) },
    { snippet: 'x'.repeat(2001) },
    { expectedUpdatedAt: undefined },
    { expectedUpdatedAt: 0 },
    { expectedUpdatedAt: '1' },
  ]) {
    const response = await app.inject({
      method: 'PUT',
      url: url + '/validation',
      headers,
      payload: { ...draft, ...patch },
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: url + '/validation',
        headers,
        payload: { ...draft, path: 'missing.md' },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: url + '/validation',
        headers,
        payload: { ...draft, note: 'x'.repeat(70000) },
      })
    ).statusCode,
    413,
  );
  assert.equal((await app.inject({ url, headers })).statusCode, 400);
  const insert = store.db.prepare(
    'INSERT INTO reader_annotations(library_id,id,path,line,snippet,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  );
  for (let i = 0; i < MAX_ANNOTATIONS_PER_FILE; i++)
    insert.run(lib.id, `limit-${i}`, draft.path, 1, '', 'saved', i + 1, i + 1);
  const capped = await app.inject({
    method: 'PUT',
    url: url + '/exceeds-limit',
    headers,
    payload: draft,
  });
  assert.equal(capped.statusCode, 413);
  assert.equal(
    (await app.inject({ url: url + '?path=' + encodeURIComponent(draft.path), headers })).json()
      .annotations.length,
    MAX_ANNOTATIONS_PER_FILE,
  );
});

test('source sync retains annotations for recovery and library removal cascades only its annotations', async (t) => {
  const { app, store, headers, user, lib, url } = await fixture();
  t.after(() => app.close());
  assert.equal(
    (await app.inject({ method: 'PUT', url: url + '/retained', headers, payload: draft }))
      .statusCode,
    200,
  );
  store.sync(user.id, lib.id, {
    baseRevision: 1,
    deleted: [draft.path],
    upserts: [{ path: 'renamed.md', content: Buffer.from('# 移动后原文').toString('base64') }],
  });
  const result = await app.inject({
    url: url + '?path=' + encodeURIComponent(draft.path),
    headers,
  });
  assert.equal(result.json().annotations.length, 1);
  const { updatedAt } = result.json().annotations[0];
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: url + '/retained',
        headers,
        payload: { ...draft, note: '整理保留的批注', expectedUpdatedAt: updatedAt },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/libraries/${lib.id}`, headers })).statusCode,
    200,
  );
  assert.equal(
    (
      store.db
        .prepare('SELECT count(*) n FROM reader_annotations WHERE library_id=?')
        .get(lib.id) as { n: number }
    ).n,
    0,
  );
});

test('static hosting preserves localized API errors and hides internal failure details', async (t) => {
  const local = path.resolve('.local');
  mkdirSync(local, { recursive: true });
  const temporary = mkdtempSync(path.join(local, 'annotation-static-test-'));
  writeFileSync(path.join(temporary, 'index.html'), '<!doctype html><title>Test reader</title>');
  const { app, store, headers, url } = await fixture(':memory:', temporary);
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(path.resolve(temporary)), local);
    rmSync(temporary, { recursive: true, force: true });
  });
  assert.equal((await app.inject({ url: '/' })).statusCode, 200);
  const invalid = await app.inject({ url: url + '?path=../invalid', headers });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: '文件路径无效' });
  store.annotations.list = () => {
    throw new Error('internal-test-detail-must-not-leak');
  };
  const failure = await app.inject({ url: url + '?path=other.md', headers });
  assert.equal(failure.statusCode, 500);
  assert.deepEqual(failure.json(), { error: '服务暂时无法完成请求，请稍后重试' });
  assert.equal(failure.body.includes('internal-test-detail'), false);
});
