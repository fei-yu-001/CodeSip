import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { buildApp } from '../server/app';
import { digest } from '../server/store';

test('reading transport compresses large text and manifests without changing source hashes, authorization or private caching', async (t) => {
  const { app, store } = await buildApp({
    database: ':memory:',
    setupToken: 'reading-transport-fixture',
    rateLimit: false,
  });
  t.after(() => app.close());
  const user = await store.createUser('transport', 'synthetic-transport-password');
  const cookie = `codesip_session=${store.session(user.id)}`;
  const library = store.createLibrary(user.id, 'Synthetic reading', 'notes');
  const bytes = Buffer.from(
    '# Synthetic long note\n\nReading should stay responsive.\n'.repeat(1000),
  );
  const small = Buffer.from('Short note');
  const png = Buffer.from([137, 80, 78, 71, ...new Array(2048).fill(0)]);
  store.sync(user.id, library.id, {
    baseRevision: 0,
    deleted: [],
    upserts: [
      { path: 'long.md', content: bytes.toString('base64') },
      { path: 'short.md', content: small.toString('base64') },
      { path: 'image.png', content: png.toString('base64') },
      ...Array.from({ length: 50 }, (_, i) => ({
        path: `notes/${i}.md`,
        content: small.toString('base64'),
      })),
    ],
  });
  const url = `/api/libraries/${library.id}/file?path=long.md`;
  for (const encoding of ['gzip', 'br, gzip;q=0.8', '*;q=0.5']) {
    const response = await app.inject({ url, headers: { cookie, 'accept-encoding': encoding } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(String(response.headers.vary), /Accept-Encoding/);
    assert.ok(response.rawPayload.length < bytes.length / 2);
    const decoded = gunzipSync(response.rawPayload);
    assert.deepEqual(decoded, bytes);
    assert.equal(
      digest(decoded),
      store.manifest(user.id, library.id).files.find((file) => file.path === 'long.md')!.hash,
    );
  }
  for (const encoding of ['', 'identity', 'br', 'gzip;q=0, *;q=1', 'gzip;q=invalid']) {
    const response = await app.inject({ url, headers: { cookie, 'accept-encoding': encoding } });
    assert.equal(response.headers['content-encoding'], undefined);
    assert.deepEqual(response.rawPayload, bytes);
  }
  for (const [file, original] of [
    ['short.md', small],
    ['image.png', png],
  ] as const) {
    const response = await app.inject({
      url: `/api/libraries/${library.id}/file?path=${file}`,
      headers: { cookie, 'accept-encoding': 'gzip' },
    });
    assert.equal(response.headers['content-encoding'], undefined);
    assert.deepEqual(response.rawPayload, original);
  }
  const manifest = await app.inject({
    url: `/api/libraries/${library.id}/manifest`,
    headers: { cookie, 'accept-encoding': 'gzip' },
  });
  assert.equal(manifest.headers['content-encoding'], 'gzip');
  assert.deepEqual(
    JSON.parse(gunzipSync(manifest.rawPayload).toString()),
    store.manifest(user.id, library.id),
  );
  assert.equal((await app.inject({ url, headers: { 'accept-encoding': 'gzip' } })).statusCode, 401);
  const other = await store.createUser('transport_other', 'synthetic-transport-password');
  assert.equal(
    (
      await app.inject({
        url,
        headers: {
          cookie: `codesip_session=${store.session(other.id)}`,
          'accept-encoding': 'gzip',
        },
      })
    ).statusCode,
    404,
  );
  const token = await app.inject({
    method: 'POST',
    url: `/api/libraries/${library.id}/token`,
    headers: { cookie, origin: 'http://127.0.0.1:4318', 'accept-encoding': 'gzip' },
  });
  assert.equal(token.statusCode, 200);
  assert.equal(token.headers['content-encoding'], undefined);
});
