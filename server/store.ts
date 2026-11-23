import { DatabaseSync } from 'node:sqlite';
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Library, FileEntry, User, SyncPatch } from '../shared/types';
import {
  ApiError,
  cleanPath,
  classify,
  excludedPath,
  MAX_FILE,
  MAX_FILES,
  MAX_LIBRARY,
} from './paths';
import type { ImportedFile } from './zip';
import { SyncServerStore } from './syncServer';
import { AnnotationStore } from './annotations';
import { DocumentCopyStore } from './documentCopies';
const scrypt = promisify(scryptCallback);
export const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
export class Store {
  db: DatabaseSync;
  syncServer: SyncServerStore;
  annotations: AnnotationStore;
  documentCopies: DocumentCopyStore;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.syncServer = new SyncServerStore(this.db);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('code','notes')),revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,path TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,is_text INTEGER NOT NULL,media_type TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(library_id,path));
      CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS library_owner ON libraries(user_id);
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
    `);
    this.annotations = new AnnotationStore(this);
    this.documentCopies = new DocumentCopyStore(this);
  }
  get needsSetup() {
    return (this.db.prepare('SELECT count(*) n FROM users').get() as any).n === 0;
  }
  async createUser(username: string, password: string): Promise<User> {
    if (
      typeof username !== 'string' ||
      !/^[a-zA-Z0-9_.@-]{3,64}$/.test(username) ||
      typeof password !== 'string' ||
      password.length < 10 ||
      password.length > 256
    )
      throw new ApiError(400, '账号为 3–64 位字母、数字或邮箱，密码至少 10 位');
    const salt = randomBytes(16).toString('hex');
    const key = (await scrypt(password, salt, 64)) as Buffer;
    const user = { id: randomUUID(), username: username.toLowerCase() };
    this.db
      .prepare('INSERT INTO users VALUES(?,?,?)')
      .run(user.id, user.username, salt + ':' + key.toString('hex'));
    return user;
  }
  async login(username: unknown, password: unknown): Promise<User> {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256)
      throw new ApiError(401, '账号或密码不正确');
    const row = this.db
      .prepare('SELECT * FROM users WHERE username=?')
      .get(username.toLowerCase()) as any;
    const [salt, hex] = row?.password.split(':') ?? ['no-such-account', '0'.repeat(128)];
    const key = (await scrypt(password, salt, 64)) as Buffer;
    if (!timingSafeEqual(key, Buffer.from(hex, 'hex')) || !row)
      throw new ApiError(401, '账号或密码不正确');
    return { id: row.id, username: row.username };
  }
  session(userId: string) {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(digest(token), userId, Date.now() + 30 * 86400000);
    return token;
  }
  authenticate(token: string, _isPlugin?: boolean): { user: User; libraryId?: string } | undefined {
    const sessionRow = this.db
      .prepare(
        'SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE hash=? AND expires>?',
      )
      .get(digest(token), Date.now()) as any;
    if (sessionRow) {
      return { user: { id: sessionRow.id, username: sessionRow.username } };
    }
    const tokenRow = this.db
      .prepare(
        'SELECT u.id,u.username,t.library_id FROM tokens t JOIN users u ON u.id=t.user_id WHERE hash=?',
      )
      .get(digest(token)) as any;
    if (tokenRow) {
      return {
        user: { id: tokenRow.id, username: tokenRow.username },
        libraryId: tokenRow.library_id,
      };
    }
    return undefined;
  }
  libraries(userId: string): Library[] {
    return this.db
      .prepare(
        `SELECT l.*,count(f.path) fileCount,coalesce(sum(f.size),0) totalBytes FROM libraries l LEFT JOIN files f ON f.library_id=l.id WHERE l.user_id=? GROUP BY l.id ORDER BY l.updated_at DESC`,
      )
      .all(userId)
      .map((r: any) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        revision: r.revision,
        updatedAt: r.updated_at,
        fileCount: r.fileCount,
        totalBytes: r.totalBytes,
      }));
  }
  library(userId: string, id: string): Library {
    const lib = this.libraries(userId).find((l) => l.id === id);
    if (!lib) throw new ApiError(404, '找不到这个项目');
    return lib;
  }
  createLibrary(userId: string, name: unknown, kind: unknown): Library {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 100 ||
      !['code', 'notes'].includes(String(kind))
    )
      throw new ApiError(400, '请填写项目名称并选择类型');
    if (this.libraries(userId).length >= 60) throw new ApiError(413, '最多保存 60 个项目或笔记库');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO libraries VALUES(?,?,?,?,0,?)')
      .run(id, userId, name.trim(), String(kind), new Date().toISOString());
    return this.library(userId, id);
  }
  manifest(userId: string, id: string) {
    return {
      library: this.library(userId, id),
      files: this.db
        .prepare(
          'SELECT path,hash,size,is_text,media_type FROM files WHERE library_id=? ORDER BY path',
        )
        .all(id)
        .map((r: any): FileEntry => ({
          path: r.path,
          hash: r.hash,
          size: r.size,
          isText: !!r.is_text,
          mediaType: r.media_type,
        })),
    };
  }
  file(userId: string, id: string, filename: string) {
    this.library(userId, id);
    const row = this.db
      .prepare('SELECT * FROM files WHERE library_id=? AND path=?')
      .get(id, cleanPath(filename)) as any;
    if (!row) throw new ApiError(404, '文件不存在或尚未同步');
    return row;
  }
  put(id: string, files: ImportedFile[], deleted: string[], expected: number) {
    const lib = this.db.prepare('SELECT revision FROM libraries WHERE id=?').get(id) as any;
    if (!lib || lib.revision !== expected)
      throw new ApiError(409, '内容已更新，请重新获取清单后重试');
    const seen = new Set<string>();
    for (const file of files) {
      file.path = cleanPath(file.path);
      if (excludedPath(file.path)) throw new ApiError(400, '此路径不参与同步');
      if (seen.has(file.path)) throw new ApiError(400, '存在重复文件');
      seen.add(file.path);
      if (file.bytes.length > MAX_FILE) throw new ApiError(413, '单个文件不得超过 8 MB');
    }
    deleted = deleted.map(cleanPath);
    for (const name of deleted) {
      if (seen.has(name)) throw new ApiError(400, '同一个文件不能同时写入和删除');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const write = this.db.prepare(
        'INSERT INTO files VALUES(?,?,?,?,?,?,?) ON CONFLICT(library_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,is_text=excluded.is_text,media_type=excluded.media_type,content=excluded.content',
      );
      for (const file of files) {
        const c = classify(file.path, file.bytes);
        write.run(
          id,
          file.path,
          digest(file.bytes),
          file.bytes.length,
          c.isText ? 1 : 0,
          c.mediaType,
          file.bytes,
        );
      }
      for (const name of deleted)
        this.db.prepare('DELETE FROM files WHERE library_id=? AND path=?').run(id, name);
      const stats = this.db
        .prepare('SELECT count(*) n,coalesce(sum(size),0) size FROM files WHERE library_id=?')
        .get(id) as any;
      if (stats.n > MAX_FILES || stats.size > MAX_LIBRARY)
        throw new ApiError(413, '项目最多 4000 个文件，合计 64 MB');
      const account = this.db
        .prepare(
          'SELECT coalesce(sum(f.size),0) size FROM files f JOIN libraries l ON f.library_id=l.id WHERE l.user_id=(SELECT user_id FROM libraries WHERE id=?)',
        )
        .get(id) as any;
      if (account.size > 512 * 1024 * 1024)
        throw new ApiError(413, '账号存储已达 512 MB，请删除不再需要的副本');
      this.db
        .prepare('UPDATE libraries SET revision=revision+1,updated_at=? WHERE id=?')
        .run(new Date().toISOString(), id);
      this.db.exec('COMMIT');
      return { revision: expected + 1 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  sync(userId: string, id: string, patch: SyncPatch) {
    const lib = this.library(userId, id);
    if (lib.kind !== 'notes') throw new ApiError(403, '同步令牌仅用于笔记库');
    if (
      !patch ||
      !Number.isSafeInteger(patch.baseRevision) ||
      !Array.isArray(patch.upserts) ||
      !Array.isArray(patch.deleted) ||
      patch.upserts.length > 100 ||
      patch.deleted.length > MAX_FILES
    )
      throw new ApiError(400, '同步请求格式无效');
    const files = patch.upserts.map((item) => {
      if (
        typeof item?.content !== 'string' ||
        item.content.length > Math.ceil(MAX_FILE / 3) * 4 ||
        item.content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content) ||
        Buffer.from(item.content, 'base64').toString('base64') !== item.content
      )
        throw new ApiError(400, '文件内容编码无效');
      return { path: cleanPath(item.path), bytes: Buffer.from(item.content, 'base64') };
    });
    return this.put(id, files, patch.deleted, patch.baseRevision);
  }
  issueToken(userId: string, id: string) {
    if (this.library(userId, id).kind !== 'notes') throw new ApiError(400, '请选择笔记库');
    const token = 'csp_' + randomBytes(32).toString('base64url');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM tokens WHERE library_id=?').run(id);
      this.db
        .prepare('INSERT INTO tokens VALUES(?,?,?,?,?)')
        .run(randomUUID(), digest(token), userId, id, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return token;
  }
  search(userId: string, id: string, query: string) {
    this.library(userId, id);
    const q = query.trim().toLowerCase();
    if (q.length < 1 || q.length > 200) throw new ApiError(400, '搜索词需要 1–200 个字符');
    const rows = this.db
      .prepare(
        'SELECT path,content FROM files WHERE library_id=? AND is_text=1 AND (instr(lower(path),?)>0 OR instr(lower(CAST(content AS TEXT)),?)>0) LIMIT 60',
      )
      .all(id, q, q) as any[];
    return rows.map((row) => {
      const text = Buffer.from(row.content).toString('utf8');
      const lines = text.split('\n');
      const line = lines.findIndex((l) => l.toLowerCase().includes(q));
      return {
        path: row.path,
        line: Math.max(1, line + 1),
        snippet: line >= 0 ? lines[line].trim().slice(0, 220) : row.path,
      };
    });
  }
}
