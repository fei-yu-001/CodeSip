import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type {
  NoteRecord,
  AssetRecord,
  SyncStateRecord,
  AssetUploadStatus,
  SyncStatus,
} from '../shared/types';
import {
  ensureFrontmatter,
  extractAssetReferences,
  formatFrontmatter,
  parseFrontmatter,
} from '../shared/frontmatter';

export const hashContent = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

export class LocalIndexer {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes_index (
        note_id TEXT PRIMARY KEY,
        file_path TEXT UNIQUE NOT NULL,
        content_hash TEXT NOT NULL,
        local_rev INTEGER NOT NULL DEFAULT 1,
        server_seq INTEGER NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL CHECK(sync_status IN ('CLEAN', 'DIRTY', 'CONFLICT')),
        is_deleted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_server_seq ON notes_index(server_seq);
      CREATE INDEX IF NOT EXISTS idx_notes_status ON notes_index(sync_status);

      CREATE TABLE IF NOT EXISTS assets_index (
        asset_hash TEXT PRIMARY KEY,
        local_rel_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        upload_status TEXT NOT NULL CHECK(upload_status IN ('LOCAL_ONLY', 'UPLOADED', 'REMOTE_ONLY'))
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        account_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        device_secret TEXT NOT NULL,
        last_pulled_seq INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  saveNote(
    filePath: string,
    rawMarkdown: string,
    deviceId: string,
    options?: { syncStatus?: SyncStatus; serverSeq?: number },
  ): { record: NoteRecord; fullMarkdown: string } {
    const existing = this.getNoteByPath(filePath);
    const defaults = {
      noteId: existing?.note_id,
      filePath,
      deviceId,
    };
    const { fullMarkdown, frontmatter } = ensureFrontmatter(rawMarkdown, defaults);
    const contentHash = hashContent(fullMarkdown);
    const now = Date.now();
    const localRev = existing ? existing.local_rev + 1 : frontmatter.revision;
    const serverSeq = options?.serverSeq ?? (existing?.server_seq || 0);
    const syncStatus: SyncStatus = options?.syncStatus || 'DIRTY';

    this.db
      .prepare(
        `INSERT INTO notes_index (note_id, file_path, content_hash, local_rev, server_seq, sync_status, is_deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           file_path = excluded.file_path,
           content_hash = excluded.content_hash,
           local_rev = excluded.local_rev,
           server_seq = excluded.server_seq,
           sync_status = excluded.sync_status,
           is_deleted = 0,
           updated_at = excluded.updated_at`,
      )
      .run(frontmatter.note_id, filePath, contentHash, localRev, serverSeq, syncStatus, now);

    const record: NoteRecord = {
      note_id: frontmatter.note_id,
      file_path: filePath,
      content_hash: contentHash,
      local_rev: localRev,
      server_seq: serverSeq,
      sync_status: syncStatus,
      is_deleted: 0,
      updated_at: now,
    };

    return { record, fullMarkdown };
  }

  getNoteById(noteId: string): NoteRecord | undefined {
    const row = this.db.prepare('SELECT * FROM notes_index WHERE note_id = ?').get(noteId) as any;
    if (!row) return undefined;
    return {
      note_id: row.note_id,
      file_path: row.file_path,
      content_hash: row.content_hash,
      local_rev: Number(row.local_rev),
      server_seq: Number(row.server_seq),
      sync_status: row.sync_status as SyncStatus,
      is_deleted: Number(row.is_deleted),
      updated_at: Number(row.updated_at),
    };
  }

  getNoteByPath(filePath: string): NoteRecord | undefined {
    const row = this.db.prepare('SELECT * FROM notes_index WHERE file_path = ?').get(filePath) as any;
    if (!row) return undefined;
    return {
      note_id: row.note_id,
      file_path: row.file_path,
      content_hash: row.content_hash,
      local_rev: Number(row.local_rev),
      server_seq: Number(row.server_seq),
      sync_status: row.sync_status as SyncStatus,
      is_deleted: Number(row.is_deleted),
      updated_at: Number(row.updated_at),
    };
  }

  deleteNote(noteId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE notes_index
         SET is_deleted = 1, sync_status = 'DIRTY', updated_at = ?
         WHERE note_id = ?`,
      )
      .run(now, noteId);
  }

  listDirtyNotes(): NoteRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM notes_index WHERE sync_status = 'DIRTY' ORDER BY updated_at ASC")
      .all() as any[];
    return rows.map((row) => ({
      note_id: row.note_id,
      file_path: row.file_path,
      content_hash: row.content_hash,
      local_rev: Number(row.local_rev),
      server_seq: Number(row.server_seq),
      sync_status: row.sync_status as SyncStatus,
      is_deleted: Number(row.is_deleted),
      updated_at: Number(row.updated_at),
    }));
  }

  saveAsset(
    bytes: Buffer,
    ext: string = '.png',
    uploadStatus: AssetUploadStatus = 'LOCAL_ONLY',
  ): AssetRecord {
    const fullHash = hashContent(bytes);
    const shortHash = fullHash.slice(0, 16);
    const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
    const relPath = `assets/${shortHash}${cleanExt}`;

    this.db
      .prepare(
        `INSERT INTO assets_index (asset_hash, local_rel_path, byte_size, upload_status)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(asset_hash) DO UPDATE SET
           local_rel_path = excluded.local_rel_path,
           byte_size = excluded.byte_size,
           upload_status = excluded.upload_status`,
      )
      .run(fullHash, relPath, bytes.length, uploadStatus);

    return {
      asset_hash: fullHash,
      local_rel_path: relPath,
      byte_size: bytes.length,
      upload_status: uploadStatus,
    };
  }

  getAsset(assetHash: string): AssetRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM assets_index WHERE asset_hash = ?')
      .get(assetHash) as any;
    if (!row) return undefined;
    return {
      asset_hash: row.asset_hash,
      local_rel_path: row.local_rel_path,
      byte_size: Number(row.byte_size),
      upload_status: row.upload_status as AssetUploadStatus,
    };
  }

  getSyncState(accountId: string): SyncStateRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sync_state WHERE account_id = ?')
      .get(accountId) as any;
    if (!row) return undefined;
    return {
      account_id: row.account_id,
      device_id: row.device_id,
      device_secret: row.device_secret,
      last_pulled_seq: Number(row.last_pulled_seq),
    };
  }

  setSyncState(state: SyncStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (account_id, device_id, device_secret, last_pulled_seq)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           device_id = excluded.device_id,
           device_secret = excluded.device_secret,
           last_pulled_seq = excluded.last_pulled_seq`,
      )
      .run(state.account_id, state.device_id, state.device_secret, state.last_pulled_seq);
  }
}
