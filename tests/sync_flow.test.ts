import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from './helpers/backend';
import { LocalIndexer } from '../server/indexer';
import { SyncEngine, type SyncTransport } from '../shared/syncEngine';
import { digest } from '../server/store';

test('End-to-End M2 sync flow: auth, cursor pull, asset upload, and conflict branching', async () => {
  const { app, store } = await buildApp({
    database: ':memory:',
    setupToken: 'codesip-development-token-test',
    rateLimit: false,
  });

  // Setup account
  const setupRes = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin: 'http://127.0.0.1:5173' },
    payload: {
      username: 'feige',
      password: 'password123456',
      setupToken: 'codesip-development-token-test',
    },
  });
  assert.equal(setupRes.statusCode, 200);

  // Device 1: PC login
  const loginPcRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'http://127.0.0.1:5173' },
    payload: {
      username: 'feige',
      password: 'password123456',
      device_id: 'pc-win-1',
      device_name: '斐哥主力PC',
      platform: 'windows',
    },
  });
  assert.equal(loginPcRes.statusCode, 200);
  const pcAuth = JSON.parse(loginPcRes.body);
  assert.ok(pcAuth.access_token);
  assert.ok(pcAuth.device_secret);

  // Device 2: Phone login
  const loginPhoneRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'http://127.0.0.1:5173' },
    payload: {
      username: 'feige',
      password: 'password123456',
      device_id: 'phone-mate60-1',
      device_name: '斐哥手机',
      platform: 'harmony',
    },
  });
  assert.equal(loginPhoneRes.statusCode, 200);
  const phoneAuth = JSON.parse(loginPhoneRes.body);
  // Shared device_secret across the same account
  assert.equal(phoneAuth.device_secret, pcAuth.device_secret);

  // Setup Client 1 (PC)
  const pcDb = new DatabaseSync(':memory:');
  const pcIndexer = new LocalIndexer(pcDb);
  pcIndexer.setSyncState({
    account_id: pcAuth.user.id,
    device_id: 'pc-win-1',
    device_secret: pcAuth.device_secret,
    last_pulled_seq: 0,
  });
  const pcFs = new Map<string, string>();
  const pcAssetFs = new Map<string, Buffer>();

  const pcTransport: SyncTransport = {
    async pullChanges(sinceSeq) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sync/changes?since_seq=${sinceSeq}`,
        headers: { authorization: `Bearer ${pcAuth.access_token}` },
      });
      return JSON.parse(res.body);
    },
    async checkAssets(hashes) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/check',
        headers: { authorization: `Bearer ${pcAuth.access_token}` },
        payload: { hashes },
      });
      return JSON.parse(res.body).missing_hashes;
    },
    async uploadAsset(hash, content) {
      store.syncServer.saveAsset(pcAuth.user.id, hash, content);
    },
    async pushNotes(notes) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: { authorization: `Bearer ${pcAuth.access_token}` },
        payload: { device_id: 'pc-win-1', notes },
      });
      return JSON.parse(res.body).results;
    },
  };

  const pcEngine = new SyncEngine({
    indexer: pcIndexer,
    transport: pcTransport,
    accountId: pcAuth.user.id,
    deviceId: 'pc-win-1',
    readLocalFile: async (p) => pcFs.get(p) ?? null,
    writeLocalFile: async (p, c) => {
      pcFs.set(p, c);
    },
    deleteLocalFile: async (p) => {
      pcFs.delete(p);
    },
    readLocalAsset: async (h) => pcAssetFs.get(h) ?? null,
  });

  // Setup Client 2 (Phone)
  const phoneDb = new DatabaseSync(':memory:');
  const phoneIndexer = new LocalIndexer(phoneDb);
  phoneIndexer.setSyncState({
    account_id: phoneAuth.user.id,
    device_id: 'phone-mate60-1',
    device_secret: phoneAuth.device_secret,
    last_pulled_seq: 0,
  });
  const phoneFs = new Map<string, string>();
  const phoneAssetFs = new Map<string, Buffer>();

  const phoneTransport: SyncTransport = {
    async pullChanges(sinceSeq) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sync/changes?since_seq=${sinceSeq}`,
        headers: { authorization: `Bearer ${phoneAuth.access_token}` },
      });
      return JSON.parse(res.body);
    },
    async checkAssets(hashes) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/check',
        headers: { authorization: `Bearer ${phoneAuth.access_token}` },
        payload: { hashes },
      });
      return JSON.parse(res.body).missing_hashes;
    },
    async uploadAsset(hash, content) {
      store.syncServer.saveAsset(phoneAuth.user.id, hash, content);
    },
    async pushNotes(notes) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: { authorization: `Bearer ${phoneAuth.access_token}` },
        payload: { device_id: 'phone-mate60-1', notes },
      });
      return JSON.parse(res.body).results;
    },
  };

  const phoneEngine = new SyncEngine({
    indexer: phoneIndexer,
    transport: phoneTransport,
    accountId: phoneAuth.user.id,
    deviceId: 'phone-mate60-1',
    readLocalFile: async (p) => phoneFs.get(p) ?? null,
    writeLocalFile: async (p, c) => {
      phoneFs.set(p, c);
    },
    deleteLocalFile: async (p) => {
      phoneFs.delete(p);
    },
    readLocalAsset: async (h) => phoneAssetFs.get(h) ?? null,
  });

  // 1. PC creates an asset and note with image reference
  const imgBuffer = Buffer.from('mock-board-image-bytes-777');
  const imgHash = digest(imgBuffer);
  pcAssetFs.set(imgHash, imgBuffer);
  pcIndexer.saveAsset(imgBuffer, '.png');

  const noteRaw = `# 算法设计与分析
![网课板书](assets/${imgHash}.png)
\`\`\`cpp
int a = 1;
\`\`\`
`;
  const saved = pcIndexer.saveNote('algo/lecture01.md', noteRaw, 'pc-win-1');
  pcFs.set('algo/lecture01.md', saved.fullMarkdown);

  // PC runs sync -> pushes note & asset
  const pcSyncResult = await pcEngine.runSync();
  assert.equal(pcSyncResult.pushedCount, 1);
  assert.equal(pcSyncResult.conflicts.length, 0);

  // 2. Phone runs sync -> pulls note
  const phoneSyncResult = await phoneEngine.runSync();
  assert.equal(phoneSyncResult.conflicts.length, 0);
  assert.ok(phoneFs.has('algo/lecture01.md'));
  assert.ok(phoneFs.get('algo/lecture01.md')!.includes('int a = 1;'));

  // 3. Concurrent edits -> Conflict simulation!
  // PC edits the note
  const pcEdited = pcFs.get('algo/lecture01.md') + '\nPC updated insight.';
  const pcNewSave = pcIndexer.saveNote('algo/lecture01.md', pcEdited, 'pc-win-1');
  pcFs.set('algo/lecture01.md', pcNewSave.fullMarkdown);

  // Phone edits the note locally too
  const phoneEdited = phoneFs.get('algo/lecture01.md') + '\nPhone mobile quick comment.';
  const phoneNewSave = phoneIndexer.saveNote('algo/lecture01.md', phoneEdited, 'phone-mate60-1');
  phoneFs.set('algo/lecture01.md', phoneNewSave.fullMarkdown);

  // PC syncs first (succeeds)
  await pcEngine.runSync();

  // Phone syncs second -> should detect conflict!
  const phoneConflictSync = await phoneEngine.runSync();
  assert.equal(phoneConflictSync.conflicts.length, 1);
  assert.equal(phoneConflictSync.conflicts[0].originalPath, 'algo/lecture01.md');
  assert.ok(phoneConflictSync.conflicts[0].conflictPath.includes('_conflict_斐哥主力PC_'));

  // Local phone version remains intact as primary
  assert.ok(phoneFs.get('algo/lecture01.md')!.includes('Phone mobile quick comment.'));
  // Conflict file is saved separately
  assert.ok(phoneFs.has(phoneConflictSync.conflicts[0].conflictPath));
  assert.ok(
    phoneFs.get(phoneConflictSync.conflicts[0].conflictPath)!.includes('PC updated insight.'),
  );

  await app.close();
});
