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
