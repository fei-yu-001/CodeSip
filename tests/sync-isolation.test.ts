import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server/app';
import { Store, digest } from '../server/store';
import { SyncServerStore } from '../server/syncServer';

const origin = 'http://127.0.0.1:4318';
const password = 'synthetic-isolation-password';
async function fixture() {
  const { app, store } = await buildApp({
    database: ':memory:',
    setupToken: 'test-sync-account-isolation',
    rateLimit: false,
  });
  const alice = await store.createUser('sync_alice', password);
  const bob = await store.createUser('sync_bob', password);
  const headers = (id: string) => ({ authorization: `Bearer ${store.session(id)}` });
  return { app, store, alice, bob, a: headers(alice.id), b: headers(bob.id) };
}

test('v1 sync isolates identical note and device IDs across accounts, including updates and deletes', async (t) => {
  const { app, store, alice, bob, a, b } = await fixture();
  t.after(() => app.close());
  for (const user of [alice, bob]) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: {
        username: user.username,
        password,
        device_id: 'shared-device',
        device_name: user.username,
        platform: 'web',
      },
    });
    assert.equal(login.statusCode, 200, login.body);
  }
  assert.equal(store.syncServer.getDeviceName(alice.id, 'shared-device'), alice.username);
  assert.equal(store.syncServer.getDeviceName(bob.id, 'shared-device'), bob.username);
  const push = (headers: typeof a, content: string, deleted = false) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers,
      payload: {
        device_id: 'shared-device',
        notes: [
          {
            note_id: 'shared-note',
            file_path: 'note.md',
            content,
            content_hash: digest(content),
            is_deleted: deleted ? 1 : 0,
          },
        ],
      },
    });
  const read = async (headers: typeof a) => {
    const response = await app.inject({ url: '/api/v1/sync/changes', headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().items;
  };
  assert.equal((await push(a, 'Alice original')).statusCode, 200);
  assert.equal((await push(b, 'Bob original')).statusCode, 200);
  assert.equal((await read(a))[0].content, 'Alice original');
  assert.equal((await read(b))[0].content, 'Bob original');
  assert.equal((await read(a))[0].device_name, alice.username);
  assert.equal((await read(b))[0].device_name, bob.username);
  assert.equal((await push(b, 'Bob edited')).statusCode, 200);
  assert.equal((await read(a))[0].content, 'Alice original');
  assert.equal((await read(b)).at(-1).content, 'Bob edited');
  assert.equal((await push(b, '', true)).statusCode, 200);
  assert.equal((await read(a))[0].content, 'Alice original');
  assert.equal((await read(b)).at(-1).is_deleted, 1);
  assert.equal((await app.inject({ url: '/api/v1/sync/changes' })).statusCode, 401);
  const library = store.createLibrary(alice.id, 'scoped-plugin', 'notes');
  const token = store.issueToken(alice.id, library.id);
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/sync/changes',
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    403,
  );
});

test('v1 attachments can be owned by both accounts without shared caching or cross-account reads', async (t) => {
  const { app, store, alice, bob, a, b } = await fixture();
  t.after(() => app.close());
  const content = Buffer.from('synthetic-image-bytes');
  const hash = digest(content);
  const url = `/api/v1/assets/${hash}`;
  store.syncServer.saveAsset(alice.id, hash, content);
  assert.equal((await app.inject({ url, headers: b })).statusCode, 404);
  assert.deepEqual(store.syncServer.checkMissingAssets(bob.id, [hash]), [hash]);
  store.syncServer.saveAsset(bob.id, hash, content);
  for (const headers of [a, b]) {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.rawPayload, content);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(store.syncServer.checkMissingAssets(bob.id, [hash]), []);
  store.syncServer.saveAsset(alice.id, hash, content);
  assert.equal(
    (store.db.prepare('SELECT count(*) n FROM server_assets').get() as { n: number }).n,
    2,
  );
  store.db.prepare('DELETE FROM users WHERE id=?').run(alice.id);
  assert.deepEqual(Buffer.from(store.syncServer.getAsset(bob.id, hash)!), content);
  assert.equal((await app.inject({ url, headers: a })).statusCode, 401);
  assert.equal((await app.inject({ url })).statusCode, 401);
});

test('legacy sync tables migrate atomically, retaining data, sequence, account ownership and restart compatibility', async (t) => {
  const base = path.resolve('.local');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'sync-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'fixture.sqlite');
  let store = new Store(filename);
  const alice = await store.createUser('migration_alice', password);
  const bob = await store.createUser('migration_bob', password);
  const secret = store.syncServer.registerDevice(
    alice.id,
    'same-device',
    'Original device',
    'harmony',
  ).device_secret;
  const content = 'Original synced note';
  const ack = store.syncServer.pushNotes(alice.id, 'same-device', [
    { note_id: 'same-note', file_path: 'note.md', content, content_hash: digest(content) },
  ]);
  const bytes = Buffer.from('legacy asset');
  store.syncServer.saveAsset(alice.id, digest(bytes), bytes);
  store.db.close();
  // Recreate the exact older global-key shape independently of the migration code.
  const legacy = new DatabaseSync(filename);
  for (const [table, key] of [
    ['user_devices', 'device_id'],
    ['server_notes', 'note_id'],
    ['server_assets', 'asset_hash'],
  ]) {
    const sql = (
      legacy.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table) as { sql: string }
    ).sql;
    const oldSchema = sql
      .replace(`"${table}"`, `${table}_old`)
      .replace(`CREATE TABLE ${table} `, `CREATE TABLE ${table}_old `)
      .replace(`${key} TEXT NOT NULL`, `${key} TEXT PRIMARY KEY`)
      .replace(new RegExp(`,\\s*PRIMARY KEY\\(user_id, ${key}\\)`), '');
    legacy.exec(oldSchema);
    legacy.exec(
      `INSERT INTO ${table}_old SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table}`,
    );
  }
  legacy.close();
  store = new Store(filename);
  try {
    assert.equal(store.syncServer.getOrCreateDeviceSecret(alice.id), secret);
    assert.equal(store.syncServer.getDeviceName(alice.id, 'same-device'), 'Original device');
    const changes = store.syncServer.getChanges(alice.id);
    assert.equal(changes.latest_seq, ack[0].server_seq);
    assert.equal(changes.items[0].content, content);
    assert.deepEqual(Buffer.from(store.syncServer.getAsset(alice.id, digest(bytes))!), bytes);
    store.syncServer.registerDevice(bob.id, 'same-device', 'Bob device', 'web');
    const next = store.syncServer.pushNotes(bob.id, 'same-device', [
      {
        note_id: 'same-note',
        file_path: 'other.md',
        content: 'Bob note',
        content_hash: digest('Bob note'),
      },
    ]);
    assert.ok(next[0].server_seq > ack[0].server_seq);
    store.syncServer.saveAsset(bob.id, digest(bytes), bytes);
    assert.equal(store.syncServer.getChanges(alice.id).items[0].content, content);
    assert.equal(store.syncServer.getChanges(bob.id).items[0].content, 'Bob note');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    store.db.close();
  }
  store = new Store(filename);
  try {
    assert.equal(store.syncServer.getChanges(alice.id).items[0].content, content);
    assert.equal(store.syncServer.getChanges(bob.id).items[0].content, 'Bob note');
    assert.deepEqual(Buffer.from(store.syncServer.getAsset(bob.id, digest(bytes))!), bytes);
    assert.equal(
      (store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check,
      'ok',
    );
  } finally {
    store.db.close();
  }
});

test('a failed account-key migration leaves all original sync tables and rows intact', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY);
      INSERT INTO users VALUES('owner');
      CREATE TABLE user_devices(device_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),device_name TEXT NOT NULL,platform TEXT NOT NULL,updated_at INTEGER NOT NULL);
      INSERT INTO user_devices VALUES('device','owner','Device','web',123);
      CREATE TABLE server_notes(note_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),file_path TEXT NOT NULL,content_hash TEXT NOT NULL,content TEXT NOT NULL,is_deleted INTEGER NOT NULL DEFAULT 0,server_seq INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
      INSERT INTO server_notes VALUES('note','owner','note.md','hash','Preserved note',0,1,123);
      CREATE TABLE server_assets(asset_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),byte_size INTEGER NOT NULL,content BLOB NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE server_assets_account_migration(blocker TEXT);
    `);
    assert.throws(() => new SyncServerStore(db), /already exists/);
    for (const table of ['user_devices', 'server_notes', 'server_assets']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        pk: number;
      }[];
      assert.equal(columns.find((column) => column.name === 'user_id')!.pk, 0);
    }
    assert.equal(
      (db.prepare('SELECT content FROM server_notes').get() as { content: string }).content,
      'Preserved note',
    );
    assert.equal(
      (db.prepare('SELECT device_name FROM user_devices').get() as { device_name: string })
        .device_name,
      'Device',
    );
    db.exec('DROP TABLE server_assets_account_migration');
    new SyncServerStore(db);
    assert.equal(
      (db.prepare('SELECT content FROM server_notes').get() as { content: string }).content,
      'Preserved note',
    );
  } finally {
    db.close();
  }
});
