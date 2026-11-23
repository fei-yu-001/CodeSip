export type LibraryKind = 'code' | 'notes';
export interface User {
  id: string;
  username: string;
}
export interface Library {
  id: string;
  name: string;
  kind: LibraryKind;
  revision: number;
  updatedAt: string;
  fileCount: number;
  totalBytes: number;
}
export interface FileEntry {
  path: string;
  hash: string;
  size: number;
  isText: boolean;
  mediaType: string;
}
export interface Manifest {
  library: Library;
  files: FileEntry[];
}
export interface SearchResult {
  path: string;
  line: number;
  snippet: string;
}
export interface SyncPatch {
  baseRevision: number;
  upserts: { path: string; content: string }[];
  deleted: string[];
}
export type SyncStatus = 'CLEAN' | 'DIRTY' | 'CONFLICT';
export type AssetUploadStatus = 'LOCAL_ONLY' | 'UPLOADED' | 'REMOTE_ONLY';
export interface NoteFrontmatter {
  note_id: string;
  title: string;
  course?: string;
  tags?: string[];
  languages?: string[];
  created_at: string;
  updated_at: string;
  revision: number;
  device_id: string;
}
export interface NoteRecord {
  note_id: string;
  file_path: string;
  content_hash: string;
  local_rev: number;
  server_seq: number;
  sync_status: SyncStatus;
  is_deleted: number;
  updated_at: number;
}
export interface AssetRecord {
  asset_hash: string;
  local_rel_path: string;
  byte_size: number;
  upload_status: AssetUploadStatus;
}
export interface SyncStateRecord {
  account_id: string;
  device_id: string;
  device_secret: string;
  last_pulled_seq: number;
}

export interface ReaderAnnotation {
  id: string;
  path: string;
  line: number;
  snippet: string;
  note: string;
  createdAt: number;
  updatedAt: number;
}
export interface AnnotationWrite {
  path: string;
  line: number;
  snippet: string;
  note: string;
  expectedUpdatedAt: number | null;
}
