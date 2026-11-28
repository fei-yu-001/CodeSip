import type {
  Library,
  Manifest,
  ReaderAnnotation,
  ReaderDocumentCopy,
  User,
} from '../../../shared/types';
import { HttpError } from '../data/http';
import { cloudLibrary, uniqueLibraries, type LibraryListing } from '../data/libraryCatalog';

export type SyncStage = 'manifest' | 'annotations' | 'documents' | 'reader-state' | 'files';
export interface SyncFailure {
  libraryId: string;
  libraryName: string;
  stage: SyncStage;
  message: string;
}
export interface LibrarySyncResult {
  libraryId: string;
  libraryName: string;
  failures: SyncFailure[];
}
export interface SyncResult {
  libraries: LibraryListing[];
  projects: LibrarySyncResult[];
  failures: SyncFailure[];
  pending: number;
  localOnly: number;
}
export interface LibrarySyncPorts {
  authenticate(signal: AbortSignal): Promise<User>;
  list(signal: AbortSignal): Promise<Library[]>;
  localLibraries(): Promise<LibraryListing[]>;
  saved(id: string): Promise<boolean>;
  pendingLibraries(): string[];
  manifest(id: string, signal: AbortSignal): Promise<Manifest>;
  annotations(id: string, signal: AbortSignal): Promise<void>;
  documents(id: string, signal: AbortSignal): Promise<void>;
  readerState(
    id: string,
    signal: AbortSignal,
  ): Promise<{ annotations: ReaderAnnotation[]; copies: ReaderDocumentCopy[] }>;
  mergeAnnotations(id: string, values: ReaderAnnotation[]): void;
  mergeDocuments(id: string, values: ReaderDocumentCopy[]): void;
  markSnapshot(id: string): void;
  files(
    manifest: Manifest,
    progress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  publish(libraries: LibraryListing[], complete: boolean): Promise<void>;
  pending(): number;
}
export async function runLibrarySync({
  user,
  ports,
  signal,
  progress,
  currentId,
  onlyIds,
}: {
  user: User;
  ports: LibrarySyncPorts;
  signal: AbortSignal;
  progress: (value: string) => void;
  currentId?: string;
  onlyIds?: string[];
}): Promise<SyncResult> {
  const check = () => signal.throwIfAborted();
  check();
  progress('正在连接…');
  const session = await ports.authenticate(signal);
  check();
  if (session.id !== user.id) throw new HttpError(401, '账号已改变，请重新登录后同步');
  const libraries = uniqueLibraries(await ports.list(signal)).map(cloudLibrary);
  check();
  const local = uniqueLibraries(await ports.localLibraries());
  check();
  const pending = new Set(ports.pendingLibraries());
  const targets = [];
  for (const library of libraries) {
    check();
    if (
      onlyIds
        ? onlyIds.includes(library.id)
        : library.id === currentId ||
          pending.has(library.id) ||
          (!currentId && (await ports.saved(library.id)))
    )
      targets.push(library);
  }
  targets.sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));
  const projects: LibrarySyncResult[] = [];
  const failedFiles = new Set<string>();
  const downloaded = new Map<string, Library>();
  for (const [index, library] of targets.entries()) {
    check();
    progress(`同步项目 ${index + 1}/${targets.length} · ${library.name}`);
    const project: LibrarySyncResult = {
      libraryId: library.id,
      libraryName: library.name,
      failures: [],
    };
    projects.push(project);
    // A feature failure is retained in its result. Cancellation and authentication
    // failures stop the whole run; ordinary errors do not skip unrelated work.
    const task = async <T>(
      stage: SyncStage,
      operation: () => Promise<T> | T,
    ): Promise<{ value: T } | undefined> => {
      check();
      try {
        const value = await operation();
        check();
        return { value };
      } catch (error) {
        check();
        if (error instanceof HttpError && error.status === 401) throw error;
        project.failures.push({
          libraryId: library.id,
          libraryName: library.name,
          stage,
          message: error instanceof Error ? error.message : '操作未完成，请重试',
        });
      }
    };
    const manifest = await task('manifest', async () => {
      const value = await ports.manifest(library.id, signal);
      if (value.library.id !== library.id) throw new Error('项目目录不匹配，已有本机存档保留');
      return value;
    });
    // Pushes use each record's saved base version, independently of source files.
    await task('annotations', () => ports.annotations(library.id, signal));
    await task('documents', () => ports.documents(library.id, signal));
    const state = await task('reader-state', () => ports.readerState(library.id, signal));
    if (state) {
      const annotations = await task('annotations', () =>
        ports.mergeAnnotations(library.id, state.value.annotations),
      );
      const documents = await task('documents', () =>
        ports.mergeDocuments(library.id, state.value.copies),
      );
      if (annotations && documents)
        await task('reader-state', () => ports.markSnapshot(library.id));
    }
    if (manifest) {
      const files = await task('files', () =>
        ports.files(
          manifest.value,
          (done, total) => progress(`项目 ${index + 1}/${targets.length} · ${done}/${total}`),
          signal,
        ),
      );
      if (!files) failedFiles.add(library.id);
      else downloaded.set(library.id, manifest.value.library);
    } else failedFiles.add(library.id);
  }
  check();
  const failures = projects.flatMap((project) => project.failures);
  const remoteIds = new Set(libraries.map((library) => library.id));
  const missing: LibraryListing[] = [];
  for (const library of local) {
    check();
    if (!remoteIds.has(library.id) && (pending.has(library.id) || (await ports.saved(library.id))))
      missing.push({ ...library, localOnly: true });
  }
  check();
  // A failed source download retains the previous revision and its directory.
  const combined = [
    ...libraries.map((library) =>
      failedFiles.has(library.id)
        ? cloudLibrary(local.find((saved) => saved.id === library.id) || library)
        : downloaded.get(library.id) || library,
    ),
    ...missing,
  ];
  await ports.publish(combined, !failures.length);
  check();
  return {
    libraries: combined,
    projects,
    failures,
    pending: ports.pending(),
    localOnly: missing.length,
  };
}
export function syncResultMessage(result: SyncResult) {
  if (result.failures.length) {
    const failed = new Set(result.failures.map((failure) => failure.libraryId)).size;
    return `同步未完成：${result.projects.length - failed} 个项目完成，${failed} 个项目仍待处理。已有本机内容保留，可重试未完成项目。`;
  }
  return result.pending
    ? `文件已同步，${result.pending} 项本机修改仍待处理，请在批注或编辑文档中查看`
    : result.localOnly
      ? `同步完成；${result.localOnly} 个旧项目已归入「仅本机保留」`
      : '同步完成，本机存档已更新';
}
