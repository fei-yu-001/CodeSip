import test from 'node:test';
import assert from 'node:assert/strict';
import { retainLocalArchives, type LibraryListing } from '../web/src/data/libraryCatalog';
const library = (id: string): LibraryListing => ({
  id,
  name: 'same-title',
  kind: 'notes',
  revision: 1,
  updatedAt: '2026-11-28T00:00:00Z',
  fileCount: 1,
  totalBytes: 10,
});
test('a forced catalog refresh keeps saved archives without duplicating a restored project', () => {
  const a = { ...library('a'), localOnly: true as const };
  const b = { ...library('b'), localOnly: true as const };
  const result = retainLocalArchives([library('a'), library('c')], [a, b, b, library('stale')]);
  assert.deepEqual(
    result.map(({ id, localOnly }) => [id, !!localOnly]),
    [
      ['a', false],
      ['c', false],
      ['b', true],
    ],
  );
  assert.equal(a.localOnly, true);
});
