import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry, Manifest, User } from '../../shared/types';
import { fileBlob, onPrivateDataCleared } from './api';

export interface VaultImageProps {
  src?: string;
  alt?: string;
  user: User;
  manifest: Manifest;
  path: string;
  offline: boolean;
}

export const DEFAULT_IMAGE_CACHE_MAX_ENTRIES = 48;
export const DEFAULT_IMAGE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_IMAGE_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_IMAGE_CONCURRENCY = 4;

interface ManifestFileIndex {
  byPath: Map<string, FileEntry>;
  byBasename: Map<string, FileEntry[]>;
}

const manifestIndexCache = new WeakMap<Manifest, ManifestFileIndex>();

function getManifestIndex(manifest: Manifest): ManifestFileIndex {
  const cached = manifestIndexCache.get(manifest);
  if (cached) return cached;
  const byPath = new Map<string, FileEntry>();
  const byBasename = new Map<string, FileEntry[]>();
  for (const file of manifest.files) {
    byPath.set(file.path, file);
    const basename = file.path.split('/').pop() || file.path;
    const list = byBasename.get(basename);
    if (list) list.push(file);
    else byBasename.set(basename, [file]);
  }
  const index = { byPath, byBasename };
  manifestIndexCache.set(manifest, index);
  return index;
}

function normalizeRelativePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/** Resolve a markdown/wikilink image target against the library manifest in O(1). */
export function resolveManifestImage(
  sourcePath: string,
  target: string,
  manifest: Manifest,
): FileEntry | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split('#')[0].split('?')[0]);
  } catch {
    return undefined;
  }
  const index = getManifestIndex(manifest);
  if (!decoded) return index.byPath.get(sourcePath);

  const parent = sourcePath.includes('/')
    ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1)
    : '';
  const candidates = [normalizeRelativePath(parent + decoded), normalizeRelativePath(decoded)];
  for (const candidate of candidates) {
    for (const value of [candidate, `${candidate}.md`]) {
      const hit = index.byPath.get(value);
      if (hit) return hit;
    }
  }

  const matches = [
    ...(index.byBasename.get(decoded) || []),
    ...(index.byBasename.get(`${decoded}.md`) || []),
  ];
  return matches.length === 1 ? matches[0] : undefined;
}

export function buildImageCacheKey(userId: string, libraryId: string, hash: string): string {
  return `${userId}\0${libraryId}\0${hash}`;
}

export interface ImageFetchRequest {
  user: User;
  libraryId: string;
  file: FileEntry;
  offline: boolean;
}

export interface ImageLoadHandle {
  promise: Promise<Blob>;
  cancel: () => void;
}

export type FetchBlobFn = (
  user: User,
  id: string,
  entry: FileEntry,
  network?: boolean,
  signal?: AbortSignal,
) => Promise<Blob>;

export interface ImageLoaderOptions {
  fetchBlob?: FetchBlobFn;
  maxConcurrency?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
}

interface CacheRecord {
  blob: Blob;
  bytes: number;
}

interface QueuedWaiter {
  cancelled: boolean;
  resolve: (blob: Blob) => void;
  reject: (err: unknown) => void;
}

interface InflightTask {
  inflightKey: string;
  cacheKey: string;
  req: ImageFetchRequest;
  controller: AbortController;
  subscribers: Set<QueuedWaiter>;
  status: 'queued' | 'running' | 'settled';
  generation: number;
}

/**
 * Bounded LRU + concurrency-limited loader for vault images.
 * Isolated strictly by (userId, libraryId, hash) and cleared on logout/data wipe.
 */
export function createVaultImageLoader(options: ImageLoaderOptions = {}) {
  const fetchBlob = options.fetchBlob ?? fileBlob;
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_IMAGE_CONCURRENCY);
  const maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_IMAGE_CACHE_MAX_ENTRIES);
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_IMAGE_CACHE_MAX_BYTES);
  const maxEntryBytes = Math.max(0, options.maxEntryBytes ?? DEFAULT_IMAGE_CACHE_MAX_ENTRY_BYTES);

  const lruCache = new Map<string, CacheRecord>();
  let totalCacheBytes = 0;

  const inflight = new Map<string, InflightTask>();
  const queue: InflightTask[] = [];
  let activeCount = 0;
  let generation = 0;

  const makeAbortError = () => new DOMException('The operation was aborted.', 'AbortError');

  const peek = (key: string): Blob | undefined => {
    const hit = lruCache.get(key);
    if (!hit) return undefined;
    lruCache.delete(key);
    lruCache.set(key, hit);
    return hit.blob;
  };

  const putCache = (key: string, blob: Blob) => {
    if (maxEntries === 0 || maxBytes === 0) return;
    const size = blob.size;
    if (size > maxEntryBytes || size > maxBytes) return;

    const existing = lruCache.get(key);
    if (existing) {
      totalCacheBytes -= existing.bytes;
      lruCache.delete(key);
    }

    while (lruCache.size >= maxEntries || totalCacheBytes + size > maxBytes) {
      const oldestKey = lruCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = lruCache.get(oldestKey)!;
      lruCache.delete(oldestKey);
      totalCacheBytes -= oldest.bytes;
    }

    lruCache.set(key, { blob, bytes: size });
    totalCacheBytes += size;
  };

  const cancelTask = (task: InflightTask) => {
    if (task.status === 'settled') return;
    const wasQueued = task.status === 'queued';
    task.status = 'settled';
    if (inflight.get(task.inflightKey) === task) {
      inflight.delete(task.inflightKey);
    }
    if (wasQueued) {
      const idx = queue.indexOf(task);
      if (idx >= 0) queue.splice(idx, 1);
    } else {
      task.controller.abort();
    }
  };

  const drain = () => {
    while (activeCount < maxConcurrency && queue.length > 0) {
      const task = queue.shift()!;
      if (task.status !== 'queued' || task.subscribers.size === 0 || task.generation !== generation) {
        continue;
      }
      task.status = 'running';
      activeCount++;
      const taskGen = task.generation;
      let requestPromise: Promise<Blob>;
      try {
        requestPromise = Promise.resolve(
          fetchBlob(
            task.req.user,
            task.req.libraryId,
            task.req.file,
            !task.req.offline,
            task.controller.signal,
          ),
        );
      } catch (err) {
        requestPromise = Promise.reject(err);
      }
      const finish = (ok: boolean, blob?: Blob, err?: unknown) => {
        if (taskGen === generation) {
          activeCount = Math.max(0, activeCount - 1);
        }
        if (task.status !== 'settled') {
          task.status = 'settled';
          if (inflight.get(task.inflightKey) === task) {
            inflight.delete(task.inflightKey);
          }
          if (ok && blob && taskGen === generation) {
            putCache(task.cacheKey, blob);
          }
          const waiters = Array.from(task.subscribers);
          task.subscribers.clear();
          for (const waiter of waiters) {
            if (waiter.cancelled) continue;
            if (ok) waiter.resolve(blob!);
            else waiter.reject(err);
          }
        }
        // Release/refill the slot even when a running task was cancelled before settling.
        if (taskGen === generation) drain();
      };
      requestPromise.then(
        (blob) => finish(true, blob),
        (err) => finish(false, undefined, err),
      );
    }
  };

  const load = (req: ImageFetchRequest): ImageLoadHandle => {
    const cacheKey = buildImageCacheKey(req.user.id, req.libraryId, req.file.hash);
    const cachedBlob = peek(cacheKey);
    if (cachedBlob) {
      return {
        promise: Promise.resolve(cachedBlob),
        cancel: () => {},
      };
    }

    const inflightKey = `${cacheKey}\0${req.offline ? 'offline' : 'online'}`;
    let task = inflight.get(inflightKey);
    if (!task) {
      task = {
        inflightKey,
        cacheKey,
        req,
        controller: new AbortController(),
        subscribers: new Set(),
        status: 'queued',
        generation,
      };
      inflight.set(inflightKey, task);
      queue.push(task);
    }

    let settled = false;
    let waiter!: QueuedWaiter;
    const promise = new Promise<Blob>((resolve, reject) => {
      waiter = {
        cancelled: false,
        resolve: (blob) => {
          settled = true;
          resolve(blob);
        },
        reject: (err) => {
          settled = true;
          reject(err);
        },
      };
      task!.subscribers.add(waiter);
    });

    if (generation === task.generation) drain();

    const cancel = () => {
      if (settled || waiter.cancelled) return;
      waiter.cancelled = true;
      settled = true;
      task!.subscribers.delete(waiter);
      waiter.reject(makeAbortError());
      if (task!.subscribers.size === 0) {
        cancelTask(task!);
      }
    };

    return { promise, cancel };
  };

  const clear = () => {
    generation++;
    activeCount = 0;
    queue.length = 0;
    const tasks = Array.from(inflight.values());
    inflight.clear();
    for (const task of tasks) {
      task.status = 'settled';
      task.controller.abort();
      const waiters = Array.from(task.subscribers);
      task.subscribers.clear();
      for (const waiter of waiters) {
        if (!waiter.cancelled) {
          waiter.cancelled = true;
          waiter.reject(makeAbortError());
        }
      }
    }
    lruCache.clear();
    totalCacheBytes = 0;
  };

  const stats = () => ({
    entries: lruCache.size,
    bytes: totalCacheBytes,
    active: activeCount,
    queued: queue.length,
    inflight: inflight.size,
  });

  return { peek, load, clear, stats };
}

export const defaultVaultImageLoader = createVaultImageLoader();
onPrivateDataCleared(() => defaultVaultImageLoader.clear());

type ObserverCallback = (isIntersecting: boolean) => void;
const sharedObservers = new Map<
  Element | null,
  { observer: IntersectionObserver; targets: Map<Element, ObserverCallback> }
>();

function observeProximity(
  element: Element,
  root: Element | null,
  onChange: ObserverCallback,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onChange(true);
    return () => {};
  }
  let entry = sharedObservers.get(root);
  if (!entry) {
    const targets = new Map<Element, ObserverCallback>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const cb = targets.get(record.target);
          if (cb) cb(record.isIntersecting || record.intersectionRatio > 0);
        }
      },
      { root, rootMargin: '480px 0px' },
    );
    entry = { observer, targets };
    sharedObservers.set(root, entry);
  }
  entry.targets.set(element, onChange);
  entry.observer.observe(element);
  return () => {
    const current = sharedObservers.get(root);
    if (!current) return;
    current.targets.delete(element);
    current.observer.unobserve(element);
    if (current.targets.size === 0) {
      current.observer.disconnect();
      sharedObservers.delete(root);
    }
  };
}

export function VaultImage({ src, alt, user, manifest, path, offline }: VaultImageProps) {
  const resolution = useMemo(() => {
    if (!src) return { status: 'empty' as const };
    if (/^https?:\/\//.test(src)) {
      return { status: 'error' as const, message: '外部图片未缓存，可在原笔记中查看' };
    }
    const file = resolveManifestImage(path, src, manifest);
    if (!file || !file.mediaType.startsWith('image/')) {
      return { status: 'error' as const, message: '图片未同步' };
    }
    return { status: 'ready' as const, file };
  }, [src, path, manifest]);

  const file = resolution.status === 'ready' ? resolution.file : undefined;
  const targetKey = file
    ? buildImageCacheKey(user.id, manifest.library.id, file.hash)
    : undefined;
  const loadKey = targetKey ? `${targetKey}\0${offline ? '1' : '0'}` : '';

  // Bind state explicitly to loadKey so changing props never briefly reuses prior image flags.
  const [inViewState, setInViewState] = useState(() => ({
    key: loadKey,
    visible: targetKey ? !!defaultVaultImageLoader.peek(targetKey) : false,
  }));
  const [renderState, setRenderState] = useState({ key: loadKey, url: '', error: '' });
  const fallbackRef = useRef<HTMLSpanElement>(null);

  const inView =
    inViewState.key === loadKey
      ? inViewState.visible
      : targetKey
        ? !!defaultVaultImageLoader.peek(targetKey)
        : false;
  const url = renderState.key === loadKey ? renderState.url : '';
  const fetchError = renderState.key === loadKey ? renderState.error : '';
  const error = resolution.status === 'error' ? resolution.message : fetchError;

  useEffect(() => {
    if (!file || !targetKey || !loadKey || url || error) return;
    const cached = defaultVaultImageLoader.peek(targetKey);
    if (cached) {
      setInViewState({ key: loadKey, visible: true });
      return;
    }
    const el = fallbackRef.current;
    if (!el) return;
    const root = el.closest('article.markdown');
    return observeProximity(el, root, (visible) => {
      setInViewState({ key: loadKey, visible });
    });
  }, [file, targetKey, loadKey, url, error]);

  const fileRef = useRef(file);
  fileRef.current = file;
  const userRef = useRef(user);
  userRef.current = user;
  const libraryId = manifest.library.id;

  useEffect(() => {
    const targetFile = fileRef.current;
    if (!targetFile || !targetKey || !loadKey || !inView) return;
    let alive = true;
    let objectUrl = '';

    const handle = defaultVaultImageLoader.load({
      user: userRef.current,
      libraryId,
      file: targetFile,
      offline,
    });

    handle.promise
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setRenderState({ key: loadKey, url: objectUrl, error: '' });
      })
      .catch((e: any) => {
        if (!alive || e?.name === 'AbortError') return;
        setRenderState({ key: loadKey, url: '', error: e?.message || '图片读取失败' });
      });

    return () => {
      alive = false;
      handle.cancel();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [targetKey, loadKey, libraryId, offline, inView]);

  return url ? (
    <img src={url} alt={alt || ''} loading="lazy" />
  ) : (
    <span ref={fallbackRef} className="image-fallback">
      {error || '加载图片…'}
      {alt ? ` · ${alt}` : ''}
    </span>
  );
}

export default VaultImage;
