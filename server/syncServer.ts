import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { digest } from './store';
import { ApiError } from './paths';

export interface ServerChangeItem {
  server_seq: number;
  note_id: string;
  file_path: string;
  content_hash: string;
  device_id: string;
  device_name: string;
  is_deleted: number;
  updated_at: number;
  content?: string;
  asset_hashes?: string[];
}

export class SyncServerStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_devices (
        device_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_secrets (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        device_secret TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_notes (
        note_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        server_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_server_notes_user ON server_notes(user_id);

      CREATE TABLE IF NOT EXISTS server_changelog (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        is_deleted INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changelog_user_seq ON server_changelog(user_id, seq);

      CREATE TABLE IF NOT EXISTS server_assets (
        asset_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        byte_size INTEGER NOT NULL,
        content BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  getOrCreateDeviceSecret(userId: string): string {
    const row = this.db
      .prepare('SELECT device_secret FROM user_secrets WHERE user_id = ?')
      .get(userId) as any;
    if (row?.device_secret) return row.device_secret;

    const secret = randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO user_secrets (user_id, device_secret) VALUES (?, ?)')
      .run(userId, secret);
    return secret;
  }

  registerDevice(
    userId: string,
    deviceId: string,
    deviceName: string,
    platform: string,
  ): { device_secret: string } {
    if (!deviceId || !deviceName) throw new ApiError(400, '设备标识与名称不能为空');
    const secret = this.getOrCreateDeviceSecret(userId);
    this.db
      .prepare(
        `INSERT INTO user_devices (device_id, user_id, device_name, platform, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           device_name = excluded.device_name,
           platform = excluded.platform,
           updated_at = excluded.updated_at`,
      )
      .run(deviceId, userId, deviceName, platform, Date.now());
    return { device_secret: secret };
  }

  getDeviceName(userId: string, deviceId: string): string {
    const row = this.db
      .prepare('SELECT device_name FROM user_devices WHERE user_id = ? AND device_id = ?')
      .get(userId, deviceId) as any;
    return row?.device_name || deviceId;
  }

  getChanges(
    userId: string,
    sinceSeq: number = 0,
    limit: number = 200,
  ): { items: ServerChangeItem[]; latest_seq: number; has_more: boolean } {
    const maxSeqRow = this.db
      .prepare('SELECT coalesce(max(seq), 0) as max_seq FROM server_changelog WHERE user_id = ?')
      .get(userId) as any;
    const latestSeq = Number(maxSeqRow?.max_seq || 0);

    const safeLimit = Math.min(Math.max(1, limit), 500);
    const rows = this.db
      .prepare(
        `SELECT seq, note_id, file_path, content_hash, device_id, device_name, is_deleted, updated_at
         FROM server_changelog
         WHERE user_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(userId, sinceSeq, safeLimit + 1) as any[];

    const hasMore = rows.length > safeLimit;
    const slice = hasMore ? rows.slice(0, safeLimit) : rows;

    const items: ServerChangeItem[] = slice.map((r) => {
      let content: string | undefined;
      if (!r.is_deleted) {
        const noteRow = this.db
          .prepare('SELECT content FROM server_notes WHERE note_id = ?')
          .get(r.note_id) as any;
        content = noteRow?.content;
      }
      return {
        server_seq: Number(r.seq),
        note_id: r.note_id,
        file_path: r.file_path,
        content_hash: r.content_hash,
        device_id: r.device_id,
        device_name: r.device_name,
        is_deleted: Number(r.is_deleted),
        updated_at: Number(r.updated_at),
        content,
      };
    });

    return { items, latest_seq: latestSeq, has_more: hasMore };
  }

  checkMissingAssets(userId: string, hashes: string[]): string[] {
    if (!hashes.length) return [];
    const missing: string[] = [];
    const stmt = this.db.prepare(
      'SELECT 1 FROM server_assets WHERE user_id = ? AND asset_hash = ?',
    );
    for (const h of hashes) {
      const exists = stmt.get(userId, h);
      if (!exists) missing.push(h);
    }
    return missing;
  }

  saveAsset(userId: string, hash: string, content: Buffer): void {
    const calculated = digest(content);
    if (calculated !== hash) throw new ApiError(400, '资产内容校验失败');
    this.db
      .prepare(
        `INSERT INTO server_assets (asset_hash, user_id, byte_size, content, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_hash) DO NOTHING`,
      )
      .run(hash, userId, content.length, content, Date.now());
  }

  getAsset(userId: string, hash: string): Buffer | undefined {
    const row = this.db
      .prepare('SELECT content FROM server_assets WHERE user_id = ? AND asset_hash = ?')
      .get(userId, hash) as any;
    return row?.content;
  }

  pushNotes(
    userId: string,
    deviceId: string,
    notes: Array<{
      note_id: string;
      file_path: string;
      content: string;
      content_hash: string;
      is_deleted?: number;
      updated_at?: number;
    }>,
  ): Array<{ note_id: string; server_seq: number }> {
    if (!notes.length) return [];
    const deviceName = this.getDeviceName(userId, deviceId);
    const results: Array<{ note_id: string; server_seq: number }> = [];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const logStmt = this.db.prepare(`
        INSERT INTO server_changelog (user_id, note_id, file_path, content_hash, device_id, device_name, is_deleted, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const noteUpsert = this.db.prepare(`
        INSERT INTO server_notes (note_id, user_id, file_path, content_hash, content, is_deleted, server_seq, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(note_id) DO UPDATE SET
          file_path = excluded.file_path,
          content_hash = excluded.content_hash,
          content = excluded.content,
          is_deleted = excluded.is_deleted,
          server_seq = excluded.server_seq,
          updated_at = excluded.updated_at
      `);

      for (const n of notes) {
        const isDeleted = n.is_deleted ? 1 : 0;
        const now = n.updated_at || Date.now();
        const contentHash = isDeleted ? '' : digest(n.content);

        const logResult = logStmt.run(
          userId,
          n.note_id,
          n.file_path,
          contentHash,
          deviceId,
          deviceName,
          isDeleted,
          now,
        );
        const serverSeq = Number(logResult.lastInsertRowid);

        noteUpsert.run(
          n.note_id,
          userId,
          n.file_path,
          contentHash,
          n.content || '',
          isDeleted,
          serverSeq,
          now,
        );
        results.push({ note_id: n.note_id, server_seq: serverSeq });
      }

      this.db.exec('COMMIT');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
