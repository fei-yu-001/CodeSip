import type { LibraryKind, Manifest, User } from '../../shared/types';
import { api, HttpError } from './data/http';
import { cached } from './data/localCache';
import { manifestKey } from './data/libraryRepository';

export interface ProjectRoute {
  kind: LibraryKind;
  id?: string;
  file?: string;
  line?: number;
  heading?: string;
}

export function readProjectRoute(hash: string): ProjectRoute {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryStart = value.indexOf('?');
  const pathname = queryStart < 0 ? value : value.slice(0, queryStart);
  const query = queryStart < 0 ? '' : value.slice(queryStart + 1);
  const [kind, id] = pathname.replace(/^\/+/, '').split('/');
  const params = new URLSearchParams(query);
  const lineValue = params.get('line');
  const parsedLine = lineValue === null ? undefined : Number(lineValue);

  return {
    kind: kind === 'notes' ? 'notes' : 'code',
    id: id || undefined,
    file: params.get('file') || undefined,
    heading: params.get('heading') || undefined,
    line:
      parsedLine === undefined
        ? undefined
        : Number.isFinite(parsedLine)
          ? Math.max(1, Math.floor(parsedLine) || 1)
          : 1,
  };
}

export class ProjectOfflineUnavailableError extends Error {
  constructor() {
    super('这个项目尚未下载，请联网后打开');
    this.name = 'ProjectOfflineUnavailableError';
  }
}

export class ProjectManifestMismatchError extends Error {
  constructor() {
    super('服务返回的项目清单与当前项目不匹配');
    this.name = 'ProjectManifestMismatchError';
  }
}

interface ProjectManifestLoadOptions {
  user: User;
  libraryId: string;
  online: boolean;
  readCache?: (key: string) => Promise<Manifest | undefined>;
  fetchManifest?: (url: string) => Promise<Manifest>;
}

export async function loadProjectManifest({
  user,
  libraryId,
  online,
  readCache = (key) => cached<Manifest>(key),
  fetchManifest = (url) => api<Manifest>(url),
}: ProjectManifestLoadOptions): Promise<{ manifest: Manifest; source: 'cache' | 'network' }> {
  const key = manifestKey(user, libraryId);
  const local = await readCache(key).catch(() => undefined);
  if (matchesLibrary(local, libraryId)) return { manifest: local, source: 'cache' };
  // Some WebViews report offline even when HTTP works. An explicit open must
  // attempt the request; connectivity hints only improve the failure message.
  try {
    const manifest = await fetchManifest(`/libraries/${encodeURIComponent(libraryId)}/manifest`);
    if (!matchesLibrary(manifest, libraryId)) throw new ProjectManifestMismatchError();
    return { manifest, source: 'network' };
  } catch (error) {
    if (
      !online &&
      !(error instanceof HttpError) &&
      !(error instanceof ProjectManifestMismatchError)
    )
      throw new ProjectOfflineUnavailableError();
    throw error;
  }
}

function matchesLibrary(manifest: Manifest | undefined, libraryId: string): manifest is Manifest {
  return !!manifest && manifest.library?.id === libraryId && Array.isArray(manifest.files);
}
