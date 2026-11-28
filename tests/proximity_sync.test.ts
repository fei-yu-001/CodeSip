import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBleBroadcastPayload,
  probeLanEndpoints,
  executeHybridSync,
} from '../shared/proximitySync';
import { LanSyncServer } from '../server/lanServer';
import { LocalIndexer } from '../server/indexer';
import { DatabaseSync } from 'node:sqlite';

test('M3/M4 ProximitySync: privacy broadcast payload, 800ms IP probing and BLE fallback', async () => {
  // 1. Privacy broadcast payload: only 8-char account hash prefix and short device ID
  const payload = createBleBroadcastPayload('user-account-12345', 'device-pc-win-abcdef123');
  assert.equal(payload.accountHashPrefix.length, 8);
  assert.equal(payload.deviceShortId.length, 8);
  assert.equal(/^[a-f0-9]{8}$/.test(payload.accountHashPrefix), true);

  // 2. Setup a mock LAN server
  const db = new DatabaseSync(':memory:');
  const indexer = new LocalIndexer(db);
  const secret = 'test-secret-32-bytes-string-0123';
  const server = new LanSyncServer({
    deviceName: 'PC',
    deviceSecret: secret,
    indexer,
    readNoteFile: async () => '# note',
    writeNoteFile: async () => {},
    readAssetFile: async () => Buffer.from('img'),
  });

  const port = await server.start();
  const token = server.issueSessionToken();

  // Test successful LAN probing
  const activeIp = await probeLanEndpoints(['127.0.0.1', '192.168.254.254'], port, token, 800);
  assert.equal(activeIp, '127.0.0.1');

  // Test failed LAN probing (unreachable IPs)
  const failedIp = await probeLanEndpoints(['192.168.254.250', '10.254.254.250'], port, token, 100);
  assert.equal(failedIp, null);

  // Test Hybrid Sync: LAN High Speed mode
  const lanResult = await executeHybridSync({
    candidateIps: ['127.0.0.1'],
    port,
    sessionToken: token,
    notesToSync: [{ noteId: 'n1', content: '# Note', assetHashes: ['a1', 'a2'] }],
    sendOverBle: async () => {},
  });
  assert.equal(lanResult.mode, 'LAN_HIGH_SPEED');
  assert.equal(lanResult.connectedIp, '127.0.0.1');
  assert.equal(lanResult.pendingAssets.length, 0);

  // Test Hybrid Sync: BLE Fallback mode
  const bleSentNotes: string[] = [];
  const fallbackResult = await executeHybridSync({
    candidateIps: ['192.168.254.254'],
    port,
    sessionToken: token,
    notesToSync: [{ noteId: 'n2', content: '# Offline Note', assetHashes: ['img-hash-1'] }],
    sendOverBle: async (id) => {
      bleSentNotes.push(id);
    },
  });
  assert.equal(fallbackResult.mode, 'BLE_FALLBACK');
  assert.equal(bleSentNotes.includes('n2'), true);
  assert.deepEqual(fallbackResult.pendingAssets, ['img-hash-1']);

  await server.close();
});
