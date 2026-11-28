import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  LanSyncServer,
  generateChallengeSignature,
  verifyChallengeResponse,
} from '../server/lanServer';
import { LocalIndexer } from '../server/indexer';

test('M4 BLE challenge-response verification and LAN high-speed sync server', async () => {
  const secret = 'fedcba9876543210fedcba9876543210';
  const nonce = 'random-nonce-16b';
  const timestamp = Date.now();

  // 1. Challenge-response HMAC test
  const sig = generateChallengeSignature(secret, nonce, timestamp);
  assert.ok(sig);
  assert.equal(verifyChallengeResponse(secret, nonce, timestamp, sig), true);
  assert.equal(verifyChallengeResponse(secret, 'wrong-nonce', timestamp, sig), false);

  // 2. Setup Indexer & local storage
  const db = new DatabaseSync(':memory:');
  const indexer = new LocalIndexer(db);
  const noteFiles = new Map<string, string>();
  const assetFiles = new Map<string, Buffer>();

  const sampleImg = Buffer.from('test-image-binary-stream');
  const assetRec = indexer.saveAsset(sampleImg, '.png');
  assetFiles.set(assetRec.asset_hash, sampleImg);

  const sampleNote = `# 随手批注
![截图](${assetRec.local_rel_path})
\`\`\`ts
const x = 10;
\`\`\`
`;
  const noteRec = indexer.saveNote('notes/review.md', sampleNote, 'pc-win-1');
  noteFiles.set('notes/review.md', noteRec.fullMarkdown);

  // 3. Start LAN Sync Server
  const lanServer = new LanSyncServer({
    deviceName: '斐哥工作站PC',
    deviceSecret: secret,
    indexer,
    readNoteFile: async (p) => noteFiles.get(p) ?? null,
    writeNoteFile: async (p, c) => {
      noteFiles.set(p, c);
    },
    readAssetFile: async (h) => assetFiles.get(h) ?? null,
  });

  const port = await lanServer.start();
  assert.ok(port > 0);
  const baseUrl = `http://127.0.0.1:${port}`;

  // 4. Unauthorized without token
  const unauthRes = await fetch(`${baseUrl}/local/ping`);
  assert.equal(unauthRes.status, 401);

  // 5. Authorized with Session Token
  const sessionToken = lanServer.issueSessionToken();
  const headers = { 'X-Session-Token': sessionToken };

  // GET /local/ping
  const pingRes = await fetch(`${baseUrl}/local/ping`, { headers });
  assert.equal(pingRes.status, 200);
  const pingData = await pingRes.json();
  assert.equal(pingData.deviceName, '斐哥工作站PC');
  assert.equal(pingData.totalNotes, 1);

  // POST /local/sync/diff
  const diffRes = await fetch(`${baseUrl}/local/sync/diff`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      notes: {
        'old-phone-note': 'old-hash',
      },
    }),
  });
  assert.equal(diffRes.status, 200);
  const diffData = await diffRes.json();
  assert.ok(diffData.phoneNeedsUpdate.includes(noteRec.record.note_id));
  assert.ok(diffData.pcNeedsUpdate.includes('old-phone-note'));

  // GET /local/file/note/:note_id
  const noteRes = await fetch(`${baseUrl}/local/file/note/${noteRec.record.note_id}`, { headers });
  assert.equal(noteRes.status, 200);
  assert.equal(noteRes.headers.get('x-content-hash'), noteRec.record.content_hash);
  const fetchedNoteText = await noteRes.text();
  assert.ok(fetchedNoteText.includes('const x = 10;'));

  // GET /local/file/asset/:hash
  const assetRes = await fetch(`${baseUrl}/local/file/asset/${assetRec.asset_hash}`, { headers });
  assert.equal(assetRes.status, 200);
  assert.equal(assetRes.headers.get('content-type'), 'image/png');
  const assetBlob = await assetRes.arrayBuffer();
  assert.equal(Buffer.from(assetBlob).equals(sampleImg), true);

  // POST /local/sync/push-note (mobile pushes back quick annotations)
  const annotatedNote = fetchedNoteText + '\n> [!NOTE] 斐哥手机在复习时划线批注';
  const pushRes = await fetch(`${baseUrl}/local/sync/push-note`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: 'notes/review.md',
      content: annotatedNote,
    }),
  });
  assert.equal(pushRes.status, 200);
  const pushJson = await pushRes.json();
  assert.equal(pushJson.ok, true);

  // Check PC file updated
  assert.ok(noteFiles.get('notes/review.md')?.includes('斐哥手机在复习时划线批注'));

  await lanServer.close();
});
