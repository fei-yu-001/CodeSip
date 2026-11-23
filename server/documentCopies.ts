import type { Store } from './store';
import { ApiError, cleanPath } from './paths';
import type { DocumentCopyWrite, ReaderDocumentCopy } from '../shared/types';
const MAX_COPY_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNT_BYTES = 32 * 1024 * 1024;
interface CopyRow {
  path: string;
  content: string;
  base_hash: string;
  updated_at: number;
}
const serialize = (row: CopyRow): ReaderDocumentCopy => ({
  path: row.path,
  content: row.content,
  baseHash: row.base_hash,
  updatedAt: row.updated_at,
});
export class DocumentCopyStore {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS reader_document_copies(
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      path TEXT NOT NULL, content TEXT NOT NULL, base_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(library_id,path)
    );`);
  }
  get(userId: string, libraryId: string, inputPath: unknown): ReaderDocumentCopy | null {
    this.store.library(userId, libraryId);
    const path = cleanPath(inputPath);
    const row = this.store.db
      .prepare('SELECT * FROM reader_document_copies WHERE library_id=? AND path=?')
      .get(libraryId, path) as CopyRow | undefined;
    return row ? serialize(row) : null;
  }
  put(userId: string, libraryId: string, input: DocumentCopyWrite): ReaderDocumentCopy {
    const library = this.store.library(userId, libraryId);
    const path = cleanPath(input?.path);
    if (library.kind !== 'notes' || !/\.md(?:own)?$/i.test(path))
      throw new ApiError(400, '仅支持编辑 Markdown 笔记的阅读版本');
    const source = this.store.file(userId, libraryId, path);
    if (!source.is_text) throw new ApiError(400, '这份文件不支持编辑');
    if (
      typeof input.content !== 'string' ||
      input.content.length > 500000 ||
      Buffer.byteLength(input.content) > MAX_COPY_BYTES
    )
      throw new ApiError(400, '文档编辑内容过长，最多 50 万字且不超过 2 MB');
    if (typeof input.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseHash))
      throw new ApiError(400, '原文版本无效');
    if (
      input.expectedUpdatedAt !== null &&
      (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt < 1)
    )
      throw new ApiError(400, '请提供上次保存的文档版本');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get(userId, libraryId, path);
      if (previous?.content === input.content && previous.baseHash === input.baseHash) {
        db.exec('COMMIT');
        return previous;
      }
      if ((previous?.updatedAt ?? null) !== input.expectedUpdatedAt)
        throw new ApiError(409, '文档已在其他设备修改，请选择要保留的版本');
      const used = (
        db
          .prepare(
            `SELECT coalesce(sum(length(CAST(c.content AS BLOB))),0) AS bytes FROM reader_document_copies c JOIN libraries l ON l.id=c.library_id WHERE l.user_id=?`,
          )
          .get(userId) as { bytes: number }
      ).bytes;
      if (
        used - Buffer.byteLength(previous?.content || '') + Buffer.byteLength(input.content) >
        MAX_ACCOUNT_BYTES
      )
        throw new ApiError(413, '已保存的编辑版本超过账号空间限制');
      const updatedAt = Math.max(Date.now(), (previous?.updatedAt || 0) + 1);
      db.prepare(
        `INSERT INTO reader_document_copies(library_id,path,content,base_hash,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(library_id,path) DO UPDATE SET content=excluded.content,base_hash=excluded.base_hash,updated_at=excluded.updated_at`,
      ).run(libraryId, path, input.content, input.baseHash, updatedAt);
      db.exec('COMMIT');
      return { path, content: input.content, baseHash: input.baseHash, updatedAt };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
