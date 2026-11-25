import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import { Store, digest } from '../server/store';
import { buildApp } from './helpers/backend';
// @ts-expect-error process lifecycle helper is shared with the JS build scripts
import { startRust, readyRust, stopRust } from '../scripts/rust.mjs';

const origin = 'http://127.0.0.1:4318';

test('Rust writes remain readable by Node; concurrent sync and copy writes have exactly one winner', async (t) => {
  const { app, store } = await buildApp({
    database: ':memory:',
    setupToken: 'rust-compatibility-setup',
    rateLimit: false,
  });
  t.after(() => app.close());
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin },
    payload: {
      username: 'compatibility',
      password: 'synthetic-rust-password',
      setupToken: 'rust-compatibility-setup',
    },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const user = setup.json().user;
  assert.deepEqual(await store.login('compatibility', 'synthetic-rust-password'), user);
  const headers = { origin, cookie: `codesip_session=${setup.cookies[0].value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/libraries',
    headers,
    payload: { name: 'Synthetic', kind: 'notes' },
  });
  const lib = created.json().library.id;
  const patch = (content: string) =>
    app.inject({
      method: 'POST',
      url: `/api/libraries/${lib}/sync`,
      headers,
      payload: {
        baseRevision: 0,
        deleted: [],
        upserts: [{ path: 'note.md', content: Buffer.from(content).toString('base64') }],
      },
    });
  const results = await Promise.all([patch('First original'), patch('Second original')]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const source = Buffer.from(store.file(user.id, lib, 'note.md').content);
  assert.equal(store.manifest(user.id, lib).library.revision, 1);
  const putCopy = (content: string) =>
    app.inject({
      method: 'PUT',
      url: `/api/libraries/${lib}/document-copy`,
      headers,
      payload: { path: 'note.md', content, baseHash: digest(source), expectedUpdatedAt: null },
    });
  const copies = await Promise.all([putCopy('First edit'), putCopy('Second edit')]);
  assert.deepEqual(copies.map((r) => r.statusCode).sort(), [200, 409]);
  assert.deepEqual(Buffer.from(store.file(user.id, lib, 'note.md').content), source);
  assert.equal(
    store.documentCopies.get(user.id, lib, 'note.md')?.content,
    copies.find((r) => r.statusCode === 200)!.json().copy.content,
  );
  const cookieToken = setup.cookies[0].value;
  assert.equal(store.authenticate(cookieToken)?.user.id, user.id);
});

test('actual HTTP ZIP import rejects traversal and expansion limits without creating a library', async (t) => {
  const { app, store } = await buildApp({
    database: ':memory:',
    setupToken: 'rust-archive-validation',
    rateLimit: false,
  });
  t.after(() => app.close());
  const user = await store.createUser('archive_reader', 'synthetic-archive-password');
  const headers = { origin, cookie: `codesip_session=${store.session(user.id)}` };
  for (const [archive, status] of [
    [Buffer.from('invalid zip'), 400],
    [Buffer.from(zipSync({ '../escape': new Uint8Array([1]) })), 400],
    [Buffer.from(zipSync({ 'oversize.md': new Uint8Array(8 * 1024 * 1024 + 1) })), 413],
  ] as const) {
    const boundary = 'rust-synthetic-boundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      archive,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const result = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(result.statusCode, status, result.body);
    assert.deepEqual(store.libraries(user.id), []);
  }
});

test('Rust startup migrates legacy account keys and keeps existing sessions, notes, secrets and rollback compatibility', async (t) => {
  const root = path.resolve('.local');
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(path.join(root, 'rust-migration-'));
  const filename = path.join(temporary, 'fixture.sqlite');
  let child: any;
  t.after(async () => {
    if (child) await stopRust(child);
    assert.equal(path.dirname(temporary), root);
    rmSync(temporary, { recursive: true, force: true });
  });
  const store = new Store(filename);
  const user = await store.createUser('migration', 'synthetic-migration-password');
  const cookie = `codesip_session=${store.session(user.id)}`;
  const deviceSecret = store.syncServer.registerDevice(
    user.id,
    'device',
    'Existing device',
    'web',
  ).device_secret;
  const content = 'Synthetic retained note';
  store.syncServer.pushNotes(user.id, 'device', [
    { note_id: 'same-note', file_path: 'note.md', content, content_hash: digest(content) },
  ]);
  const asset = Buffer.from('synthetic asset');
  store.syncServer.saveAsset(user.id, digest(asset), asset);
  store.db.close();
  const fixture = new DatabaseSync(filename);
  for (const [table, key] of [
    ['user_devices', 'device_id'],
    ['server_notes', 'note_id'],
    ['server_assets', 'asset_hash'],
  ]) {
    const schema = (
      fixture.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table) as { sql: string }
    ).sql;
    const old = schema
      .replace(`CREATE TABLE ${table} `, `CREATE TABLE ${table}_old `)
      .replace(`${key} TEXT NOT NULL`, `${key} TEXT PRIMARY KEY`)
      .replace(new RegExp(`,\\s*PRIMARY KEY\\(user_id, ${key}\\)`), '');
    fixture.exec(old);
    fixture.exec(
      `INSERT INTO ${table}_old SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table}`,
    );
  }
  fixture.close();
  for (let restart = 0; restart < 2; restart++) {
    child = startRust({
      HOST: '127.0.0.1',
      PORT: '0',
      NODE_ENV: 'test',
      CODESIP_DB: filename,
      CODESIP_SETUP_TOKEN: 'rust-migration-test',
      CODESIP_RATE_LIMIT: 'off',
    });
    const address = await readyRust(child);
    const response = await fetch(`${address}/api/v1/sync/changes`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const changes = await response.json();
    assert.equal(changes.items[0].content, content);
    assert.equal(changes.latest_seq, 1);
    const read = new DatabaseSync(filename, { readOnly: true });
    for (const table of ['user_devices', 'server_notes', 'server_assets']) {
      assert.ok(
        (read.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[]).some(
          (r) => r.name === 'user_id' && r.pk > 0,
        ),
      );
    }
    assert.equal(
      (read.prepare('SELECT device_secret FROM user_secrets WHERE user_id=?').get(user.id) as any)
        .device_secret,
      deviceSecret,
    );
    assert.deepEqual(read.prepare('PRAGMA foreign_key_check').all(), []);
    read.close();
    await stopRust(child);
    child = undefined;
  }
  const rollback = new Store(filename);
  try {
    assert.deepEqual(await rollback.login('migration', 'synthetic-migration-password'), user);
    assert.equal(rollback.syncServer.getChanges(user.id).items[0].content, content);
    assert.deepEqual(Buffer.from(rollback.syncServer.getAsset(user.id, digest(asset))!), asset);
  } finally {
    rollback.db.close();
  }
});
