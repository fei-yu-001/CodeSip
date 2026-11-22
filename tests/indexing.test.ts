import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LocalIndexer } from '../server/indexer';
import {
  parseFrontmatter,
  formatFrontmatter,
  ensureFrontmatter,
  extractLanguages,
  extractAssetReferences,
} from '../shared/frontmatter';
import type { NoteFrontmatter } from '../shared/types';

test('frontmatter parsing, serialization and auto language extraction', () => {
  const sample = `---
note_id: "550e8400-e29b-41d4-a716-446655440000"
title: "第04讲：动态规划状态压缩与位运算优化"
course: "算法设计与分析"
tags: ["DP", "位运算", "C++"]
languages: ["cpp", "python"]
created_at: "2026-11-22T14:30:00Z"
updated_at: "2026-11-22T15:12:45Z"
revision: 4
device_id: "pc-win-9a8b7c"
---

## 核心思路总结
状态压缩 DP 的本质是将集合状态映射为二进制整数...
![网课板书截图](assets/a3f9c21e88d40b12.png)
\`\`\`cpp
// 枚举子集的标准位运算模板
for (int sub = mask; sub > 0; sub = (sub - 1) & mask) {
  dp[mask] = min(dp[mask], dp[mask ^ sub] + cost[sub]);
}
\`\`\`
`;

  const { frontmatter, content } = parseFrontmatter(sample);
  assert.ok(frontmatter);
  assert.equal(frontmatter.note_id, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(frontmatter.title, '第04讲：动态规划状态压缩与位运算优化');
  assert.equal(frontmatter.course, '算法设计与分析');
  assert.deepEqual(frontmatter.tags, ['DP', '位运算', 'C++']);
  assert.deepEqual(frontmatter.languages, ['cpp', 'python']);
  assert.equal(frontmatter.revision, 4);
  assert.equal(frontmatter.device_id, 'pc-win-9a8b7c');
  assert.ok(content.includes('## 核心思路总结'));

  // extractLanguages
  const langs = extractLanguages(content);
  assert.deepEqual(langs, ['cpp']);

  // extractAssetReferences
  const assets = extractAssetReferences(content);
  assert.deepEqual(assets, ['a3f9c21e88d40b12']);

  // ensureFrontmatter with raw content without frontmatter
  const rawText = '# Test\n```ts\nconst x = 1;\n```';
  const ensured = ensureFrontmatter(rawText, {
    filePath: 'study/algo.md',
    deviceId: 'test-device-1',
  });
  assert.ok(ensured.frontmatter.note_id);
  assert.equal(ensured.frontmatter.title, 'algo');
  assert.equal(ensured.frontmatter.device_id, 'test-device-1');
  assert.deepEqual(ensured.frontmatter.languages, ['ts']);
  assert.equal(ensured.frontmatter.revision, 1);
});

test('LocalIndexer SQLite tables, note upsert and soft delete tombstone', () => {
  const db = new DatabaseSync(':memory:');
  const indexer = new LocalIndexer(db);

  const initialNote = indexer.saveNote(
    'algo/dp.md',
    '# Dynamic Programming\n```python\nprint(1)\n```',
    'device-mac-1',
  );
  assert.equal(initialNote.record.file_path, 'algo/dp.md');
  assert.equal(initialNote.record.sync_status, 'DIRTY');
  assert.equal(initialNote.record.is_deleted, 0);
  assert.equal(initialNote.record.local_rev, 1);

  // Read back
  const read = indexer.getNoteById(initialNote.record.note_id);
  assert.ok(read);
  assert.equal(read.content_hash, initialNote.record.content_hash);

  // Update note
  const updatedNote = indexer.saveNote(
    'algo/dp.md',
    initialNote.fullMarkdown + '\nUpdated note content',
    'device-mac-1',
  );
  assert.equal(updatedNote.record.note_id, initialNote.record.note_id);
  assert.equal(updatedNote.record.local_rev, 2);

  // Soft delete tombstone
  indexer.deleteNote(initialNote.record.note_id);
  const deleted = indexer.getNoteById(initialNote.record.note_id);
  assert.ok(deleted);
  assert.equal(deleted.is_deleted, 1);
  assert.equal(deleted.sync_status, 'DIRTY');

  const dirtyList = indexer.listDirtyNotes();
  assert.equal(dirtyList.length, 1);
  assert.equal(dirtyList[0].note_id, initialNote.record.note_id);
});

test('LocalIndexer asset content-addressed deduplication and sync state', () => {
  const db = new DatabaseSync(':memory:');
  const indexer = new LocalIndexer(db);

  const imgBytes = Buffer.from('fake-png-content-123456');
  const asset1 = indexer.saveAsset(imgBytes, '.png', 'LOCAL_ONLY');
  assert.ok(asset1.asset_hash);
  assert.equal(asset1.local_rel_path, `assets/${asset1.asset_hash.slice(0, 16)}.png`);
  assert.equal(asset1.byte_size, imgBytes.length);

  // Deduplication check
  const asset2 = indexer.saveAsset(imgBytes, '.png', 'UPLOADED');
  assert.equal(asset1.asset_hash, asset2.asset_hash);
  assert.equal(asset2.upload_status, 'UPLOADED');

  const fetched = indexer.getAsset(asset1.asset_hash);
  assert.ok(fetched);
  assert.equal(fetched.upload_status, 'UPLOADED');

  // Sync state
  indexer.setSyncState({
    account_id: 'acc-uuid-1',
    device_id: 'dev-1',
    device_secret: '0123456789abcdef0123456789abcdef',
    last_pulled_seq: 42,
  });

  const state = indexer.getSyncState('acc-uuid-1');
  assert.ok(state);
  assert.equal(state.device_id, 'dev-1');
  assert.equal(state.last_pulled_seq, 42);
  assert.equal(state.device_secret, '0123456789abcdef0123456789abcdef');
});
