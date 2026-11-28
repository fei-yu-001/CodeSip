import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from './helpers/backend';
import { buildApp as buildLegacy } from '../server/app';

for (const [name, build] of [
  ['Rust', buildApp],
  ['Node compatibility', buildLegacy],
] as const) {
  test(`${name} serves a page policy for client API connections without relaxing scripts or imported files`, async (t) => {
    const root = path.resolve('.local');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'qiqi-policy-'));
    t.after(async () => {
      assert.equal(path.dirname(path.resolve(directory)), root);
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      path.join(directory, 'index.html'),
      '<!doctype html><title>synthetic fixture</title>',
    );
    const { app, store } = await build({
      database: ':memory:',
      setupToken: 'synthetic-policy-setup',
      rateLimit: false,
      staticDir: directory,
    });
    t.after(() => app.close());
    await app.ready();
    const response = await app.inject({ url: '/' });
    assert.equal(response.statusCode, 200);
    const policy = String(response.headers['content-security-policy']);
    const directives = new Map(
      policy.split(';').map((item) => {
        const [key, ...values] = item.trim().split(/\s+/);
        return [key, values];
      }),
    );
    assert.deepEqual(directives.get('connect-src'), [
      "'self'",
      'https:',
      'http://localhost:*',
      'http://127.0.0.1:*',
    ]);
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.deepEqual(directives.get('object-src'), ["'none'"]);
    assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
    assert.deepEqual(directives.get('worker-src'), ["'self'"]);
    assert.equal((await app.inject({ url: '/api/libraries' })).statusCode, 401);
    const user = await store.createUser('policy-reader', 'synthetic-policy-password');
    const cookie = `codesip_session=${store.session(user.id)}`;
    const library = store.createLibrary(user.id, 'Synthetic policy', 'notes');
    store.sync(user.id, library.id, {
      baseRevision: 0,
      deleted: [],
      upserts: [
        { path: 'sample.html', content: Buffer.from('<h1>Read only</h1>').toString('base64') },
      ],
    });
    const imported = await app.inject({
      url: `/api/libraries/${library.id}/file?path=sample.html`,
      headers: { cookie },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.match(String(imported.headers['content-type']), /^text\/plain/);
  });
}
