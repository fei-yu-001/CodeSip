import type { LocalIndexer } from '../server/indexer';
import type { ServerChangeItem } from '../server/syncServer';
import { extractAssetReferences } from './frontmatter';

export interface SyncConflict {
  originalPath: string;
  conflictPath: string;
  remoteDevice: string;
}

export interface SyncTransport {
  pullChanges(sinceSeq: number): Promise<{
    items: ServerChangeItem[];
    latest_seq: number;
    has_more: boolean;
  }>;
  checkAssets(hashes: string[]): Promise<string[]>;
  uploadAsset(hash: string, content: Buffer): Promise<void>;
  pushNotes(
    notes: Array<{
      note_id: string;
      file_path: string;
      content: string;
      content_hash: string;
      is_deleted?: number;
    }>,
  ): Promise<Array<{ note_id: string; server_seq: number }>>;
}

export function formatConflictPath(filePath: string, deviceName: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const stamp = `${yyyy}${mm}${dd}_${hh}${min}`;
  const safeDevice = deviceName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_');

  const dotIdx = filePath.lastIndexOf('.');
  if (dotIdx > 0) {
    const base = filePath.slice(0, dotIdx);
    const ext = filePath.slice(dotIdx);
    return `${base}_conflict_${safeDevice}_${stamp}${ext}`;
  }
  return `${filePath}_conflict_${safeDevice}_${stamp}.md`;
}

export class SyncEngine {
  indexer: LocalIndexer;
  transport: SyncTransport;
  accountId: string;
  deviceId: string;
  readLocalFile: (path: string) => Promise<string | null>;
  writeLocalFile: (path: string, content: string) => Promise<void>;
  deleteLocalFile: (path: string) => Promise<void>;
  readLocalAsset: (hash: string) => Promise<Buffer | null>;

  constructor(options: {
    indexer: LocalIndexer;
    transport: SyncTransport;
    accountId: string;
    deviceId: string;
    readLocalFile: (path: string) => Promise<string | null>;
    writeLocalFile: (path: string, content: string) => Promise<void>;
    deleteLocalFile: (path: string) => Promise<void>;
    readLocalAsset: (hash: string) => Promise<Buffer | null>;
  }) {
    this.indexer = options.indexer;
    this.transport = options.transport;
    this.accountId = options.accountId;
    this.deviceId = options.deviceId;
    this.readLocalFile = options.readLocalFile;
    this.writeLocalFile = options.writeLocalFile;
    this.deleteLocalFile = options.deleteLocalFile;
    this.readLocalAsset = options.readLocalAsset;
  }

  async runSync(): Promise<{ conflicts: SyncConflict[]; pushedCount: number }> {
    const conflicts: SyncConflict[] = [];

    // Step 1: Pull
    const syncState = this.indexer.getSyncState(this.accountId);
    let lastPulledSeq = syncState?.last_pulled_seq || 0;

    let hasMore = true;
    while (hasMore) {
      const resp = await this.transport.pullChanges(lastPulledSeq);
      if (!resp || !Array.isArray(resp.items)) {
        throw new Error(`同步增量拉取失败: ${JSON.stringify(resp)}`);
      }
      hasMore = !!resp.has_more;

      // Step 2: Merge
      for (const R of resp.items) {
        if (R.server_seq <= lastPulledSeq) continue;
        const L = this.indexer.getNoteById(R.note_id);

        if (!L) {
          // 情况 A: 本地不存在
          if (R.is_deleted === 0 && R.content !== undefined) {
            await this.writeLocalFile(R.file_path, R.content);
            this.indexer.saveNote(R.file_path, R.content, R.device_id, {
              syncStatus: 'CLEAN',
              serverSeq: R.server_seq,
            });
          }
        } else if (L.sync_status === 'CLEAN') {
          // 情况 B: 本地无未同步修改
          if (R.is_deleted === 1) {
            await this.deleteLocalFile(L.file_path);
            this.indexer.deleteNote(L.note_id);
          } else if (R.content !== undefined) {
            await this.writeLocalFile(R.file_path, R.content);
            this.indexer.saveNote(R.file_path, R.content, R.device_id, {
              syncStatus: 'CLEAN',
              serverSeq: R.server_seq,
            });
          }
        } else if (L.sync_status === 'DIRTY' && L.content_hash !== R.content_hash) {
          // 情况 C: 并发冲突
          if (R.is_deleted === 0 && R.content !== undefined) {
            const conflictPath = formatConflictPath(R.file_path, R.device_name);
            await this.writeLocalFile(conflictPath, R.content);
            this.indexer.saveNote(conflictPath, R.content, R.device_id, {
              syncStatus: 'DIRTY',
            });
            conflicts.push({
              originalPath: L.file_path,
              conflictPath,
              remoteDevice: R.device_name,
            });
          }
        }

        lastPulledSeq = Math.max(lastPulledSeq, R.server_seq);
      }

      if (resp.items.length === 0) break;
    }

    // Step 3: Push
    const dirtyNotes = this.indexer.listDirtyNotes();
    let pushedCount = 0;

    if (dirtyNotes.length > 0) {
      const allAssetHashes = new Set<string>();
      const pushPayload: Array<{
        note_id: string;
        file_path: string;
        content: string;
        content_hash: string;
        is_deleted?: number;
      }> = [];

      for (const note of dirtyNotes) {
        if (note.is_deleted) {
          pushPayload.push({
            note_id: note.note_id,
            file_path: note.file_path,
            content: '',
            content_hash: '',
            is_deleted: 1,
          });
        } else {
          const content = await this.readLocalFile(note.file_path);
          if (content !== null) {
            pushPayload.push({
              note_id: note.note_id,
              file_path: note.file_path,
              content,
              content_hash: note.content_hash,
              is_deleted: 0,
            });
            for (const h of extractAssetReferences(content)) {
              allAssetHashes.add(h);
            }
          }
        }
      }

      // Check missing assets and upload
      if (allAssetHashes.size > 0) {
        const missing = await this.transport.checkAssets(Array.from(allAssetHashes));
        for (const h of missing) {
          const assetBytes = await this.readLocalAsset(h);
          if (assetBytes) {
            await this.transport.uploadAsset(h, assetBytes);
          }
        }
      }

      // Push notes
      if (pushPayload.length > 0) {
        const ack = await this.transport.pushNotes(pushPayload);
        for (const item of ack) {
          this.indexer.saveNote(
            dirtyNotes.find((n) => n.note_id === item.note_id)?.file_path || '',
            pushPayload.find((p) => p.note_id === item.note_id)?.content || '',
            this.deviceId,
            { syncStatus: 'CLEAN', serverSeq: item.server_seq },
          );
          lastPulledSeq = Math.max(lastPulledSeq, item.server_seq);
        }
        pushedCount = ack.length;
      }
    }

    // Update sync state
    const curSecret = syncState?.device_secret || '';
    this.indexer.setSyncState({
      account_id: this.accountId,
      device_id: this.deviceId,
      device_secret: curSecret,
      last_pulled_seq: lastPulledSeq,
    });

    return { conflicts, pushedCount };
  }
}
