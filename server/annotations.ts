import type { Store } from './store';
import type { AnnotationWrite, ReaderAnnotation } from '../shared/types';
import { ApiError, cleanPath } from './paths';

interface AnnotationRow {
  id: string;
  path: string;
  line: number;
  snippet: string;
  note: string;
  created_at: number;
  updated_at: number;
  deleted: number;
}
export const MAX_ANNOTATIONS_PER_FILE = 500;
export const MAX_ANNOTATIONS_PER_ACCOUNT = 5000;
const serialize = (row: AnnotationRow): ReaderAnnotation => ({
  id: row.id,
  path: row.path,
  line: row.line,
  snippet: row.snippet,
  note: row.note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const validateId = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ApiError(400, '批注标识无效');
};
const validateVersion = (value: unknown, nullable = false) => {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ApiError(400, '请提供批注的上次保存版本');
};
const conflict = () =>
  new ApiError(409, '批注已在其他设备更新或删除，请刷新后确认');

export class AnnotationStore {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS reader_annotations(
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      id TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL,
      snippet TEXT NOT NULL, note TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(library_id,id)
    );
    CREATE INDEX IF NOT EXISTS annotation_file ON reader_annotations(library_id,path,deleted,line);`);
  }
  list(userId: string, libraryId: string, filename: unknown): ReaderAnnotation[] {
    this.store.library(userId, libraryId);
    const filenameClean = cleanPath(filename);
    // Annotations survive file removal/rename. The original path remains available
    // for recovery, and no imported source or note is ever rewritten.
    return (
      this.store.db
        .prepare(
          'SELECT * FROM reader_annotations WHERE library_id=? AND path=? AND deleted=0 ORDER BY line,created_at,id',
        )
        .all(libraryId, filenameClean) as unknown as AnnotationRow[]
    ).map(serialize);
  }
  put(userId: string, libraryId: string, id: string, input: AnnotationWrite): ReaderAnnotation {
    this.store.library(userId, libraryId);
    validateId(id);
    const filename = cleanPath(input?.path);
    if (
      !Number.isSafeInteger(input?.line) ||
      input.line < 1 ||
      input.line > 2000000 ||
      typeof input?.snippet !== 'string' ||
      input.snippet.length > 2000 ||
      typeof input?.note !== 'string' ||
      !input.note.trim() ||
      input.note.length > 10000
    ) {
      throw new ApiError(400, '批注内容为 1–10000 字，引用不超过 2000 字，行号须为有效正整数');
    }
    validateVersion(input.expectedUpdatedAt, true);
    const note = input.note.trim();
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db
        .prepare('SELECT * FROM reader_annotations WHERE library_id=? AND id=?')
        .get(libraryId, id) as unknown as AnnotationRow | undefined;
      if (previous) {
        if (previous.deleted || previous.path !== filename) throw conflict();
        // A lost response may cause an identical retry. Return the committed record
        // without touching its version; a different stale edit always conflicts.
        if (
          previous.line === input.line &&
          previous.note === note &&
          previous.snippet === input.snippet
        ) {
          db.exec('COMMIT');
          return serialize(previous);
        }
        if (input.expectedUpdatedAt !== previous.updated_at) throw conflict();
      } else {
        if (input.expectedUpdatedAt !== null) throw conflict();
        const file = this.store.file(userId, libraryId, filename);
        if (!file.is_text) throw new ApiError(400, '当前文件不支持文字批注');
        const fileCount = db
          .prepare(
            'SELECT count(*) n FROM reader_annotations WHERE library_id=? AND path=? AND deleted=0',
          )
          .get(libraryId, filename) as { n: number };
        const accountCount = db
          .prepare(
            'SELECT count(*) n FROM reader_annotations a JOIN libraries l ON l.id=a.library_id WHERE l.user_id=?',
          )
          .get(userId) as { n: number };
        if (
          fileCount.n >= MAX_ANNOTATIONS_PER_FILE ||
          accountCount.n >= MAX_ANNOTATIONS_PER_ACCOUNT
        )
          throw new ApiError(413, '批注数量已达上限，暂时无法新增');
      }
      const timestamp = Math.max(Date.now(), (previous?.updated_at || 0) + 1);
      if (previous) {
        db.prepare(
          'UPDATE reader_annotations SET line=?,snippet=?,note=?,updated_at=? WHERE library_id=? AND id=?',
        ).run(input.line, input.snippet, note, timestamp, libraryId, id);
      } else {
        db.prepare(
          'INSERT INTO reader_annotations(library_id,id,path,line,snippet,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(libraryId, id, filename, input.line, input.snippet, note, timestamp, timestamp);
      }
      db.exec('COMMIT');
      return {
        id,
        path: filename,
        line: input.line,
        snippet: input.snippet,
        note,
        createdAt: previous?.created_at || timestamp,
        updatedAt: timestamp,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  delete(userId: string, libraryId: string, id: string, expected: unknown) {
    this.store.library(userId, libraryId);
    validateId(id);
    validateVersion(expected);
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db
        .prepare('SELECT * FROM reader_annotations WHERE library_id=? AND id=?')
        .get(libraryId, id) as unknown as AnnotationRow | undefined;
      if (previous && !previous.deleted) {
        if (expected !== previous.updated_at) throw conflict();
        // Keep a small tombstone so an offline device cannot resurrect a deletion.
        db.prepare(
          "UPDATE reader_annotations SET deleted=1,note='',snippet='',updated_at=? WHERE library_id=? AND id=?",
        ).run(Math.max(Date.now(), previous.updated_at + 1), libraryId, id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
