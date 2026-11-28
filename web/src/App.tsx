import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CloudOff,
  Cloud,
  Laptop,
  Smartphone,
  Code2,
  Copy,
  Download,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  Layers3,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  Maximize2,
  Minimize2,
  Moon,
  MessageCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  UploadCloud,
  WifiOff,
  WrapText,
  X,
} from 'lucide-react';
import type {
  FileEntry,
  Library,
  LibraryKind,
  Manifest,
  SearchResult,
  User,
} from '../../shared/types';
import { api, HttpError } from './data/http';
import { cached, save, remove } from './data/localCache';
import { clearPrivateData } from './data/privateData';
import { cacheGeneration } from './data/session';
import {
  cachedLibraries,
  manifestKey,
  fileBlob,
  downloadLibrary,
  removeLibraryCache,
  cacheFileRemoval,
} from './data/libraryRepository';
import { formatBytes, relativeDate } from './format';
import { readTheme, type ReaderTheme, type OutlineItem } from './readerState';
import { navigateHash, useDismissibleLayer } from './readerNavigation';
import Modal from './Modal';
import { useLibrarySync } from './useLibrarySync';
import LibrarySyncStatus from './LibrarySyncStatus';
import './sync-setup.css';
import ReaderWorkspace from './ReaderWorkspace';
import MobileReaderToolbar from './MobileReaderToolbar';
import './reader-space.css';
import QiqiPanel from './QiqiPanel';
import { openQiqi } from './qiqiChat';
import ReadingThemeMenu from './ReadingThemeMenu';
import { retainLocalArchives, type LibraryListing } from './data/libraryCatalog';
import './library-archives.css';
import LibraryCard from './LibraryCard';
import { removeLibraryReaderData } from './readerIdentity';
import './file-management.css';
import './reader-layout-improvements.css';
import {
  loadProjectManifest,
  readProjectRoute,
  ProjectManifestMismatchError,
} from './projectNavigation';

type DeleteTarget = { library: Library; file?: FileEntry };
const readRoute = () => readProjectRoute(location.hash);
function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'small' : ''}`}>
      <img src="/icon.svg" alt="" />
      <div>
        CodeSip<span>饭后溜溜码</span>
      </div>
    </div>
  );
}
function Auth({
  setup,
  onSuccess,
  notify,
}: {
  setup: boolean;
  onSuccess: (user: User) => void;
  notify: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const result = await api<{ user: User }>(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(data)),
      });
      await save('profile', result.user);
      onSuccess(result.user);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <section className="auth-story">
        <img className="auth-image" src="/art/code-study.webp" alt="" fetchPriority="high" />
        <Brand />
      </section>
      <section className="auth-form-area">
        <div className="auth-card">
          <h2>{setup ? '创建账号' : '欢迎回来'}</h2>
          <form onSubmit={submit}>
            <label>
              账号
              <input
                name="username"
                autoComplete="username"
                placeholder="你的账号或邮箱"
                required
                minLength={3}
                maxLength={64}
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                autoComplete={setup ? 'new-password' : 'current-password'}
                placeholder={setup ? '至少 10 位字符' : '输入密码'}
                required
                minLength={setup ? 10 : 1}
              />
            </label>
            {setup && (
              <label>
                首次设置密钥
                <input
                  name="setupToken"
                  type="password"
                  placeholder="部署时生成的设置密钥"
                  required
                  autoComplete="off"
                />
                <small>仅首次建立账号需要，由服务器管理员提供。</small>
              </label>
            )}
            <button className="button primary wide" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={18} /> : null}
              {setup ? '创建账号' : '进入 CodeSip'}
              <ArrowRight size={17} />
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  file: boolean;
}
function makeTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const path of paths) {
    let level = root;
    const parts = path.split('/');
    parts.forEach((name, i) => {
      let node = level.find((n) => n.name === name);
      if (!node) {
        node = {
          name,
          path: parts.slice(0, i + 1).join('/'),
          children: [],
          file: i === parts.length - 1,
        };
        level.push(node);
      }
      level = node.children;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root);
  return root;
}
function Tree({
  nodes,
  active,
  onOpen,
  onDelete,
  deleteDisabled,
  depth = 0,
}: {
  nodes: TreeNode[];
  active?: string;
  onOpen: (s: string) => void;
  onDelete: (path: string) => void;
  deleteDisabled: boolean;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.file ? (
          <div key={node.path} className="tree-file-row">
            <button
              className={`tree-file ${node.path === active ? 'active' : ''}`}
              style={{ paddingLeft: 14 + depth * 16 }}
              onClick={() => onOpen(node.path)}
              title={node.path}
            >
              {/\.md$/i.test(node.name) ? (
                <FileText size={15} />
              ) : /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i.test(node.name) ? (
                <ImageIcon size={15} />
              ) : (
                <FileCode2 size={15} />
              )}
              <span>{node.name}</span>
            </button>
            <button
              className="icon-button tree-file-delete"
              aria-label={`删除文件 ${node.path}`}
              title="删除文件"
              disabled={deleteDisabled}
              onClick={() => onDelete(node.path)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ) : (
          <details key={node.path} open={depth < 2}>
            <summary style={{ paddingLeft: 12 + depth * 16 }}>
              <ChevronRight size={13} />
              <Folder size={15} />
              <span>{node.name}</span>
            </summary>
            <Tree
              nodes={node.children}
              active={active}
              onOpen={onOpen}
              onDelete={onDelete}
              deleteDisabled={deleteDisabled}
              depth={depth + 1}
            />
          </details>
        ),
      )}
    </>
  );
}
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [boot, setBoot] = useState(true),
    [needsSetup, setNeedsSetup] = useState(false),
    [offline, setOffline] = useState(!navigator.onLine),
    [message, setMessage] = useState('');
  const [route, setRoute] = useState(readRoute),
    [libraries, setLibraries] = useState<LibraryListing[]>([]),
    [manifest, setManifest] = useState<Manifest>(),
    [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''),
    [fileFilter, setFileFilter] = useState(''),
    [results, setResults] = useState<SearchResult[] | null>(null),
    [searchBusy, setSearchBusy] = useState(false),
    [showSearch, setShowSearch] = useState(false),
    [showTree, setShowTree] = useState(false),
    [showOutline, setShowOutline] = useState(false);
  const [modal, setModal] = useState<'import' | 'connect' | 'delete' | 'account' | null>(null),
    [name, setName] = useState(''),
    [zip, setZip] = useState<File | null>(null),
    [importTarget, setImportTarget] = useState('auto'),
    [token, setToken] = useState(''),
    [createdSyncLibrary, setCreatedSyncLibrary] = useState<Library>(),
    [deletedLibraryId, setDeletedLibraryId] = useState<string>(),
    [deletedFile, setDeletedFile] = useState<{ libraryId: string; path: string }>(),
    [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(),
    [deleteError, setDeleteError] = useState(''),
    [progress, setProgress] = useState(''),
    [outline, setOutline] = useState<OutlineItem[]>([]);
  const syncLibrary =
    createdSyncLibrary ||
    (manifest?.library.id === route.id && manifest?.library.kind === 'notes'
      ? manifest.library
      : undefined);
  useEffect(() => {
    if (modal !== 'connect') {
      setCreatedSyncLibrary(undefined);
      setToken('');
    }
  }, [modal]);
  const [projectError, setProjectError] = useState('');
  const [theme, setTheme] = useState<ReaderTheme>(readTheme);
  const dark = theme === 'warm-slate';
  const [jump, setJump] = useState(0);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [showEmptyLibs, setShowEmptyLibs] = useState(false);
  const [notesOnly, setNotesOnly] = useState(true);
  const [wrap, setWrap] = useState(localStorage.getItem('codesip:wrap') !== 'false'),
    [offlineSaved, setOfflineSaved] = useState(false);
  const notify = useCallback((value: string) => setMessage(value), []);
  useEffect(() => {
    const failure = () => notify('本机存档未能保存，请检查存储空间；当前内容仍可阅读');
    window.addEventListener('codesip:cache-write-failed', failure);
    return () => {
      window.removeEventListener('codesip:cache-write-failed', failure);
    };
  }, [notify]);
  const searchSeq = useRef(0);
  const manifestSeq = useRef(0);
  const routeScopeRef = useRef({ kind: route.kind, id: route.id });
  routeScopeRef.current = { kind: route.kind, id: route.id };
  const setRouteTo = useCallback(
    (kind: LibraryKind, id?: string, file?: string, line?: number, heading?: string) => {
      if (line !== undefined || heading !== undefined) setJump((value) => value + 1);
      const query = file
        ? `?file=${encodeURIComponent(file)}${line !== undefined ? `&line=${line}` : ''}${heading ? `&heading=${encodeURIComponent(heading)}` : ''}`
        : '';
      navigateHash(`${kind}${id ? '/' + id : ''}${query}`);
    },
    [],
  );
  const logoutLocal = useCallback(async (preserveDrafts = false) => {
    manifestSeq.current++;
    await clearPrivateData(preserveDrafts);
    setUser(null);
    setLibraries([]);
    setManifest(undefined);
    location.hash = '';
  }, []);
  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof HttpError && error.status === 401) {
        void logoutLocal(true);
        notify('登录已过期，请重新登录');
      } else notify((error as Error).message || '操作失败，请重试');
    },
    [logoutLocal, notify],
  );
  useEffect(() => {
    const hash = () => {
      setRoute(readRoute());
      setShowTree(false);
      setShowSearch(false);
      setResults(null);
      setQuery('');
    };
    window.addEventListener('hashchange', hash);
    return () => window.removeEventListener('hashchange', hash);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme === 'warm-slate' ? 'dark' : 'light';
    try {
      localStorage.setItem('codesip:reader-theme', theme);
      localStorage.setItem('codesip:theme', theme === 'warm-slate' ? 'dark' : 'light');
    } catch {
      /* Theme changes still work without storage. */
    }
  }, [theme]);
  useEffect(() => {
    localStorage.setItem('codesip:wrap', String(wrap));
  }, [wrap]);
  useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(''), 5000);
    return () => clearTimeout(timeout);
  }, [message]);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const profile = await cached<User>('profile').catch(() => undefined);
        if (!active) return;
        if (profile) {
          setUser(profile);
          return;
        }
        const status = await api<{ needsSetup: boolean }>('/status');
        if (!active) return;
        setNeedsSetup(status.needsSetup);
        if (!status.needsSetup) {
          try {
            const session = await api<{ user: User }>('/session');
            if (active) {
              setUser(session.user);
              await save('profile', session.user);
            }
          } catch (e) {
            if (e instanceof HttpError && e.status === 401) await clearPrivateData(true);
            else throw e;
          }
        }
        setOffline(false);
      } catch (e) {
        if (!(e instanceof HttpError)) {
          const profile = await cached<User>('profile');
          if (active && profile) {
            setUser(profile);
            setOffline(true);
          } else if (active) notify('无法连接服务，请检查网络后刷新');
        } else notify((e as Error).message);
      } finally {
        if (active) setBoot(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      if (!user) return;
      const generation = cacheGeneration();
      try {
        if (!force) {
          const local = await cachedLibraries(user);
          if (generation !== cacheGeneration()) return;
          if (local) {
            setLibraries(local);
            return;
          }
        }
        const data = await api<{ libraries: Library[] }>('/libraries');
        if (generation !== cacheGeneration()) return;
        const next = retainLocalArchives(data.libraries, (await cachedLibraries(user)) || []);
        if (generation !== cacheGeneration()) return;
        setLibraries(next);
        await save(`${user.id}:libraries`, next);
        setOffline(false);
      } catch (e) {
        if (generation !== cacheGeneration()) return;
        if (!(e instanceof HttpError)) {
          setLibraries((await cachedLibraries(user)) || []);
          setOffline(true);
        } else handleError(e);
      }
    },
    [user, handleError],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const online = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', off);
    };
  }, [refresh]);
  const loadManifest = useCallback(async () => {
    const seq = ++manifestSeq.current;
    setProjectError('');
    if (!user || !route.id) {
      setManifest(undefined);
      return;
    }
    try {
      const result = await loadProjectManifest({
        user,
        libraryId: route.id,
        online: navigator.onLine,
      });
      // A late response must not write private data after logout or a newer navigation.
      if (seq !== manifestSeq.current) return;
      if (result.source === 'network') {
        await save(manifestKey(user, route.id), result.manifest).catch(() =>
          notify('本机存档未能保存，请检查存储空间'),
        );
        if (seq !== manifestSeq.current) return;
        setOffline(false);
      }
      setManifest(result.manifest);
    } catch (e) {
      if (seq !== manifestSeq.current) return;
      if (e instanceof HttpError && e.status === 401) {
        handleError(e);
        return;
      }
      setManifest(undefined);
      if (e instanceof HttpError) {
        setProjectError(
          e.status === 404
            ? '找不到这个项目：它可能已被删除，或不属于当前账号。'
            : e.message || '项目读取失败，请重试',
        );
      } else if (e instanceof ProjectManifestMismatchError) {
        setProjectError(e.message);
      } else {
        setProjectError(
          navigator.onLine
            ? '无法连接服务器，这个项目还没有本机存档。请检查网络后重试。'
            : '这个项目尚未下载，请联网后打开',
        );
      }
    }
  }, [user, route.id, handleError, notify]);
  const latestLoadManifest = useRef(loadManifest);
  latestLoadManifest.current = loadManifest;
  const librarySync = useLibrarySync({
    user,
    currentId: route.id,
    blocked: !!progress || busy,
    notify,
    onError: handleError,
    onSynced: async (result) => {
      setLibraries(result.libraries);
      setOffline(false);
      // Refresh only the active project's successfully published directory.
      // Failed source downloads retain the reader and its previous revision.
      if (
        result.projects.some(
          (project) =>
            project.libraryId === route.id &&
            !project.failures.some(
              (failure) => failure.stage === 'manifest' || failure.stage === 'files',
            ),
        )
      )
        await latestLoadManifest.current();
    },
  });
  const isRefreshing = librarySync.running;
  const syncProgress = librarySync.progress;
  useEffect(() => {
    setManifest(undefined);
    setOfflineSaved(false);
    setFileFilter('');
    setOutline([]);
    void loadManifest();
    return () => {
      manifestSeq.current++;
    };
  }, [loadManifest]);
  useEffect(() => {
    if (
      !user ||
      !route.id ||
      !manifest ||
      manifest.library.id !== route.id ||
      route.file ||
      !manifest.files.length
    )
      return;
    const remembered =
      localStorage.getItem(`codesip:reading:${user!.id}:${manifest.library.id}`) ||
      localStorage.getItem(`codesip:reading:${manifest.library.id}`);
    const target =
      manifest.files.find((f) => f.path === remembered) ||
      manifest.files.find((f) => /^readme\.md$/i.test(f.path)) ||
      manifest.files.find((f) => f.isText);
    if (target)
      navigateHash(`${route.kind}/${route.id}?file=${encodeURIComponent(target.path)}`, true);
  }, [user, manifest, route.id, route.file]);
  useEffect(() => {
    if (!user || !manifest) return;
    let active = true;
    cached<{ revision: number }>(`${user.id}:offline:${manifest.library.id}`).then((value) => {
      if (active) setOfflineSaved(value?.revision === manifest.library.revision);
    });
    return () => {
      active = false;
    };
  }, [user, manifest]);
  const visibleLibraries = useMemo(
    () =>
      libraries.filter(
        (l) =>
          !l.localOnly &&
          l.kind === route.kind &&
          l.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [libraries, route.kind, query],
  );
  const localArchives = libraries.filter(
    (library) =>
      library.localOnly &&
      library.kind === route.kind &&
      library.name.toLowerCase().includes(query.toLowerCase()),
  );
  const { activeLibraries, emptyLibraries } = useMemo(() => {
    const active: Library[] = [];
    const empty: Library[] = [];
    for (const lib of visibleLibraries) {
      if (lib.fileCount > 0) active.push(lib);
      else empty.push(lib);
    }
    return { activeLibraries: active, emptyLibraries: empty };
  }, [visibleLibraries]);
  const isImageFile = (p: string) => /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i.test(p);
  const { noteFiles, assetFiles } = useMemo(() => {
    const notes: string[] = [];
    const assets: string[] = [];
    for (const f of manifest?.files || []) {
      if (isImageFile(f.path)) assets.push(f.path);
      else notes.push(f.path);
    }
    return { noteFiles: notes, assetFiles: assets };
  }, [manifest]);

  const tree = useMemo(() => {
    let paths = (manifest?.files || []).map((f) => f.path);
    if (manifest?.library.kind === 'notes' && notesOnly) {
      paths = paths.filter((p) => !isImageFile(p));
    }
    if (fileFilter) {
      paths = paths.filter((p) => p.toLowerCase().includes(fileFilter.toLowerCase()));
    }
    return makeTree(paths);
  }, [manifest, fileFilter, notesOnly]);
  const currentFile = manifest?.files.find((f) => f.path === route.file);
  const isMarkdown = !!route.file && /\.md(?:own)?$/i.test(route.file);
  const openFile = useCallback(
    (path: string, line?: number) => {
      const { kind, id } = routeScopeRef.current;
      setRouteTo(kind, id, path, line);
      setShowSearch(false);
      setShowTree(false);
      setShowOutline(false);
    },
    [setRouteTo],
  );
  const importName = name.trim() || zip?.name.replace(/\.zip$/i, '') || '';
  const matchingImports = libraries.filter(
    (lib) => !lib.localOnly && lib.kind === route.kind && lib.name === importName,
  );
  const updateTarget =
    importTarget === 'auto'
      ? matchingImports.length === 1
        ? matchingImports[0]
        : undefined
      : libraries.find(
          (lib) => !lib.localOnly && lib.id === importTarget && lib.kind === route.kind,
        );
  const ambiguousImport = importTarget === 'auto' && matchingImports.length > 1;
  useEffect(() => {
    if (modal !== 'import') {
      setImportTarget('auto');
      setZip(null);
    }
  }, [modal]);
  async function doImport(event: FormEvent) {
    event.preventDefault();
    if (!zip || ambiguousImport) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', zip);
      const data = await api<{ library: Library }>(
        `/import?kind=${route.kind}&name=${encodeURIComponent(importName)}${updateTarget ? `&libraryId=${encodeURIComponent(updateTarget.id)}&baseRevision=${updateTarget.revision}` : ''}`,
        { method: 'POST', body: form },
      );
      await refresh(true);
      const updated = await api<Manifest>(`/libraries/${data.library.id}/manifest`);
      await save(manifestKey(user!, data.library.id), updated);
      if (route.id === data.library.id) setManifest(updated);
      const retained =
        route.id === data.library.id && updated.files.some((file) => file.path === route.file)
          ? route.file
          : undefined;
      setModal(null);
      setZip(null);
      setName('');
      setRouteTo(data.library.kind, data.library.id, retained);
      notify(updateTarget ? '项目已更新，批注和阅读记录已保留' : '导入完成，开始阅读吧');
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) await refresh(true);
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setBusy(true);
    try {
      let lib = syncLibrary;
      if (!lib || lib.kind !== 'notes') {
        lib = (
          await api<{ library: Library }>('/libraries', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim() || '我的学习笔记', kind: 'notes' }),
          })
        ).library;
        setCreatedSyncLibrary(lib);
        await refresh(true);
      }
      const data = await api<{ token: string }>(`/libraries/${lib.id}/token`, { method: 'POST' });
      setToken(JSON.stringify({ server: location.origin, libraryId: lib.id, token: data.token }));
      notify('连接信息已生成，仅在这里显示一次');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  async function saveOffline() {
    if (!user || !manifest || busy || isRefreshing) return;
    setProgress('准备保存…');
    try {
      await downloadLibrary(user, manifest, (done, total) => setProgress(`${done} / ${total}`));
      setOfflineSaved(true);
      notify('已保存完整离线副本，包含图片与附件');
    } catch (e) {
      handleError(e);
    } finally {
      setProgress('');
    }
  }
  async function performSearch(event: FormEvent) {
    event.preventDefault();
    if (!route.id || !query.trim() || !user || !manifest) return;
    const seq = ++searchSeq.current;
    setSearchBusy(true);
    try {
      if (offline || offlineSaved) {
        const matches: SearchResult[] = [];
        for (const file of manifest.files.filter((f) => f.isText)) {
          const body = await fileBlob(user, manifest.library.id, file, false)
            .then((b) => b.text())
            .catch(() => '');
          const lines = body.split('\n');
          const n = lines.findIndex((l) => l.toLowerCase().includes(query.toLowerCase()));
          if (n >= 0 || file.path.toLowerCase().includes(query.toLowerCase()))
            matches.push({
              path: file.path,
              line: Math.max(1, n + 1),
              snippet: n >= 0 ? lines[n].trim().slice(0, 220) : file.path,
            });
          if (matches.length >= 60) break;
        }
        if (seq === searchSeq.current) setResults(matches);
      } else {
        const data = await api<{ results: SearchResult[] }>(
          `/libraries/${route.id}/search?q=${encodeURIComponent(query)}`,
        );
        if (seq === searchSeq.current) setResults(data.results);
      }
    } catch (e) {
      handleError(e);
    } finally {
      if (seq === searchSeq.current) setSearchBusy(false);
    }
  }
  const requestDelete = (library: Library, file?: FileEntry) => {
    if (busy || isRefreshing || progress) return;
    setDeleteTarget({ library, file });
    setDeleteError('');
    setShowTree(false);
    setModal('delete');
  };
  async function removeSelected() {
    if (!user || !deleteTarget || busy || isRefreshing || progress) return;
    const target = deleteTarget;
    const id = target.library.id;
    const generation = cacheGeneration();
    setBusy(true);
    setDeleteError('');
    try {
      const updated = target.file
        ? await api<Manifest>(`/libraries/${id}/file`, {
            method: 'DELETE',
            body: JSON.stringify({ path: target.file.path, baseRevision: target.library.revision }),
          })
        : await api(`/libraries/${id}`, { method: 'DELETE' })
            .catch((error) => {
              if (!(error instanceof HttpError && error.status === 404)) throw error;
            })
            .then(() => undefined);
      if (generation !== cacheGeneration()) return;
      if (routeScopeRef.current.id === id) manifestSeq.current++;
      searchSeq.current++;
      setResults(null);
      let localError = false;
      if (updated && target.file) {
        setDeletedFile({ libraryId: id, path: target.file.path });
        setManifest((current) => (current?.library.id === id ? updated : current));
        setLibraries((current) =>
          current.map((library) => (library.id === id ? updated.library : library)),
        );
        try {
          await cacheFileRemoval(user, updated);
        } catch {
          localError = true;
          // Invalidate a stale directory even when storage cannot publish the new one.
          await Promise.allSettled([
            remove(manifestKey(user, id)),
            remove(`${user.id}:offline:${id}`),
          ]);
        }
      } else {
        setDeletedLibraryId(id);
        setLibraries((current) => current.filter((library) => library.id !== id));
        if (routeScopeRef.current.id === id) {
          setManifest(undefined);
          setRouteTo(target.library.kind);
        }
        try {
          await removeLibraryCache(user, id);
          removeLibraryReaderData(user.id, id);
        } catch {
          localError = true;
        }
      }
      if (generation !== cacheGeneration()) return;
      setModal(null);
      notify(
        localError
          ? '云端已删除，本机清理未完成，请联网后重新同步'
          : target.file
            ? '文件已删除，电脑原文件保留'
            : '项目已删除，电脑原文件保留',
      );
    } catch (error) {
      if (generation !== cacheGeneration()) return;
      if (error instanceof HttpError && error.status === 401) handleError(error);
      else
        setDeleteError(
          error instanceof HttpError && error.status === 409
            ? '项目内容已更新，请取消删除并同步后重新确认。'
            : error instanceof HttpError
              ? error.message
              : '未能连接服务，删除未确认。请联网后重试。',
        );
    } finally {
      setBusy(false);
    }
  }
  const synchronize = () => librarySync.run();
  const enterFocus = () => {
    setShowTree(false);
    setShowSearch(false);
    setShowOutline(false);
    setFocused(true);
  };
  useDismissibleLayer(focused && !!route.id, () => setFocused(false));
  useEffect(() => {
    if (!route.id) setFocused(false);
  }, [route.id]);
  useDismissibleLayer(showTree, () => setShowTree(false));
  useDismissibleLayer(showSearch, () => setShowSearch(false));
  useDismissibleLayer(showOutline, () => setShowOutline(false));
  useDismissibleLayer(themeMenuOpen, () => setThemeMenuOpen(false));
  useDismissibleLayer(!!modal, () => {
    if (!busy) setModal(null);
  });
  if (boot)
    return (
      <div className="boot">
        <Brand />
        <LoaderCircle className="spin" size={24} />
      </div>
    );
  const toast = message ? (
    <div className="toast" role="status">
      <span>{message}</span>
      <button aria-label="关闭提示" onClick={() => setMessage('')}>
        <X size={16} />
      </button>
    </div>
  ) : null;
  if (!user)
    return (
      <>
        <Auth setup={needsSetup} onSuccess={setUser} notify={notify} />
        {toast}
      </>
    );
  return (
    <div
      className={`app ${route.id ? 'reading' : ''} ${focused && route.id ? 'reading-focused' : ''}`}
    >
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">资料库</div>
        <nav>
          <button
            className={route.kind === 'code' ? 'selected' : ''}
            onClick={() => setRouteTo('code')}
          >
            <Code2 size={19} />
            代码项目<span>{libraries.filter((l) => !l.localOnly && l.kind === 'code').length}</span>
          </button>
          <button
            className={route.kind === 'notes' ? 'selected' : ''}
            onClick={() => setRouteTo('notes')}
          >
            <BookOpen size={19} />
            学习笔记
            <span>{libraries.filter((l) => !l.localOnly && l.kind === 'notes').length}</span>
          </button>
          <button aria-label="打开七七" aria-haspopup="dialog" onClick={openQiqi}>
            <MessageCircle size={19} />
            七七
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">
              <img src="/qiqi-avatar.jpg" alt="七七头像" />
            </div>
            <div>
              <strong>{user.username}</strong>
            </div>
            <button
              className="icon-button"
              aria-label="退出登录"
              title="管理账号与退出"
              onClick={() => setModal('account')}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="mobile-brand">
              <img src="/icon.svg" alt="CodeSip" />
            </span>
            <button onClick={() => setRouteTo(route.kind)}>
              {route.kind === 'code' ? '代码项目' : '学习笔记'}
            </button>
            {route.id && (
              <>
                <ChevronRight size={14} />
                <span>{manifest?.library.name || (projectError ? '项目不可用' : '加载中…')}</span>
              </>
            )}
          </div>
          <div className="top-actions">
            {route.id && (
              <button
                className="icon-button qiqi-launcher"
                aria-label="打开七七"
                aria-haspopup="dialog"
                onClick={openQiqi}
              >
                <MessageCircle size={18} />
                <span>七七</span>
              </button>
            )}
            <button
              className="icon-button reader-theme-toggle"
              aria-label="切换明暗主题"
              title="阅读主题"
              aria-haspopup="dialog"
              aria-expanded={themeMenuOpen}
              onClick={() => setThemeMenuOpen(true)}
            >
              {dark ? <Moon size={17} /> : <Sun size={17} />}
              <span>主题</span>
            </button>
            {offline && (
              <span className="offline-label">
                <WifiOff size={14} /> 离线
              </span>
            )}
            <button
              className={`icon-button sync-button ${isRefreshing ? 'is-spinning' : ''}`}
              aria-label={isRefreshing ? '正在同步' : '同步'}
              title={isRefreshing ? syncProgress : '同步云端更新和本机修改'}
              disabled={!!progress || isRefreshing}
              onClick={() => void synchronize()}
            >
              <RefreshCw size={17} className={isRefreshing ? 'spin-icon' : ''} />
              <span>{isRefreshing ? '同步中' : '同步'}</span>
            </button>
            <button
              className="icon-button user-profile-btn"
              aria-label="账号与退出"
              title={`当前账号：${user.username} (点击管理账号)`}
              onClick={() => setModal('account')}
            >
              <div className="avatar-mini">
                <img src="/qiqi-avatar.jpg" alt="七七头像" />
              </div>
            </button>
          </div>
        </header>
        <LibrarySyncStatus sync={librarySync} blocked={!!progress || busy} />
        {!route.id && (
          <div className="dashboard">
            <section className={`welcome welcome-${route.kind}`} aria-labelledby="collection-title">
              <img
                className="welcome-image"
                src={route.kind === 'code' ? '/art/code-study.webp' : '/art/notes-study.webp'}
                alt=""
                fetchPriority="high"
              />
              <div className="welcome-copy">
                <span className="welcome-count">
                  {
                    libraries.filter((library) => !library.localOnly && library.kind === route.kind)
                      .length
                  }
                  {route.kind === 'code' ? ' 个项目' : ' 个笔记库'}
                </span>
                <h1 id="collection-title">{route.kind === 'code' ? '代码项目' : '学习笔记'}</h1>
                <div className="collection-actions">
                  {route.kind === 'notes' && (
                    <button
                      className="button primary"
                      disabled={offline}
                      onClick={() => {
                        setToken('');
                        setName('');
                        setModal('connect');
                      }}
                    >
                      <Link2 size={16} />
                      设置云端同步
                    </button>
                  )}
                  <button
                    className={`button ${route.kind === 'notes' ? 'secondary' : 'primary'}`}
                    disabled={offline}
                    onClick={() => {
                      setZip(null);
                      setName('');
                      setModal('import');
                    }}
                  >
                    <Plus size={17} />
                    导入{route.kind === 'code' ? '项目' : '笔记'}
                  </button>
                </div>
              </div>
            </section>
            <section className="library-section">
              <div className="library-toolbar">
                <label className="search-input">
                  <Search size={17} />
                  <input
                    aria-label={route.kind === 'code' ? '查找项目' : '查找笔记库'}
                    placeholder={route.kind === 'code' ? '查找项目…' : '查找笔记库…'}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button aria-label="清空搜索" onClick={() => setQuery('')}>
                      <X size={14} />
                    </button>
                  )}
                </label>
                <span className="sort-label">
                  最近更新 <ChevronDown size={14} />
                </span>
              </div>
              {visibleLibraries.length ? (
                <>
                  <div className="library-grid">
                    {(activeLibraries.length > 0 ? activeLibraries : visibleLibraries).map(
                      (library, i) => (
                        <LibraryCard
                          key={library.id}
                          library={library}
                          index={i}
                          open={() => setRouteTo(library.kind, library.id)}
                          remove={() => requestDelete(library)}
                          disabled={busy || isRefreshing || !!progress}
                        />
                      ),
                    )}
                    <button
                      className="add-card"
                      disabled={offline}
                      onClick={() => setModal('import')}
                    >
                      <span>
                        <Plus size={22} />
                      </span>
                      <strong>添加{route.kind === 'code' ? '项目' : '笔记库'}</strong>
                    </button>
                  </div>

                  {activeLibraries.length > 0 && emptyLibraries.length > 0 && (
                    <div className="empty-libs-fold">
                      <button
                        type="button"
                        className="empty-libs-fold-toggle"
                        onClick={() => setShowEmptyLibs(!showEmptyLibs)}
                      >
                        <span>空库 / 未同步目录 ({emptyLibraries.length})</span>
                        {showEmptyLibs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      {showEmptyLibs && (
                        <div className="library-grid folded-grid">
                          {emptyLibraries.map((library, i) => (
                            <LibraryCard
                              key={library.id}
                              library={library}
                              index={i}
                              open={() => setRouteTo(library.kind, library.id)}
                              remove={() => requestDelete(library)}
                              disabled={busy || isRefreshing || !!progress}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="empty-library">
                  <div className="empty-icon">
                    {route.kind === 'code' ? <FolderOpen size={34} /> : <BookOpen size={34} />}
                  </div>
                  <h3>
                    {query ? '没有匹配的内容' : route.kind === 'code' ? '暂无项目' : '暂无笔记'}
                  </h3>
                  <p>
                    {query
                      ? '换一个关键词试试看。'
                      : route.kind === 'code'
                        ? '导入 ZIP 文件，或打开示例项目。'
                        : '设置云端同步，或导入笔记 ZIP。'}
                  </p>
                  {!query && (
                    <div className="empty-buttons">
                      <button
                        className="button primary"
                        disabled={offline}
                        onClick={() => setModal(route.kind === 'code' ? 'import' : 'connect')}
                      >
                        {route.kind === 'code' ? <UploadCloud size={17} /> : <Link2 size={17} />}{' '}
                        {route.kind === 'code' ? '导入第一个项目' : '设置云端同步'}
                      </button>
                      <button
                        className="button text"
                        disabled={busy || offline}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await api('/demo', { method: 'POST' });
                            await refresh(true);
                            notify('已添加示例');
                          } catch (e) {
                            handleError(e);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        先看看示例 <ArrowRight size={16} />
                      </button>
                    </div>
                  )}
                </div>
              )}
              {!!localArchives.length && (
                <details className="local-library-archives">
                  <summary>仅本机保留 ({localArchives.length})</summary>
                  <p>这些项目已从云端移除，本机存档和批注仍保留。</p>
                  <div className="library-grid" role="region" aria-label="仅本机保留的项目">
                    {localArchives.map((library, index) => (
                      <LibraryCard
                        key={library.id}
                        library={library}
                        index={index}
                        open={() => setRouteTo(library.kind, library.id)}
                        remove={() => requestDelete(library)}
                        disabled={busy || isRefreshing || !!progress}
                      />
                    ))}
                  </div>
                </details>
              )}
            </section>
          </div>
        )}
        <div className="reader-layout" hidden={!route.id}>
          <aside
            id="project-file-tree"
            aria-label="项目目录"
            className={`file-panel ${showTree ? 'open' : ''}`}
          >
            <div className="panel-title">
              <button
                className="icon-button reader-back"
                aria-label="返回项目列表"
                title="返回项目列表"
                onClick={() => setRouteTo(route.kind)}
              >
                <ArrowLeft size={18} />
              </button>
              <span title={manifest?.library.name}>
                <FolderOpen size={17} />
                <span className="directory-project-name">
                  {manifest?.library.name || '项目目录'}
                </span>
              </span>
              <button
                className="icon-button mobile-only"
                aria-label="关闭目录"
                onClick={() => setShowTree(false)}
              >
                <X size={17} />
              </button>
            </div>
            <label className="file-filter">
              <Search size={14} />
              <input
                aria-label="筛选文件"
                placeholder="快速找文件…"
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
              />
            </label>
            {manifest?.library.kind === 'notes' && assetFiles.length > 0 && (
              <div className="tree-filter-pills">
                <button
                  type="button"
                  className={`tree-pill ${notesOnly ? 'active' : ''}`}
                  onClick={() => setNotesOnly(true)}
                >
                  笔记 ({noteFiles.length})
                </button>
                <button
                  type="button"
                  className={`tree-pill ${!notesOnly ? 'active' : ''}`}
                  onClick={() => setNotesOnly(false)}
                >
                  全部 ({manifest.files.length})
                </button>
              </div>
            )}
            <div className="tree">
              {tree.length ? (
                <Tree
                  nodes={tree}
                  active={route.file}
                  onOpen={openFile}
                  deleteDisabled={
                    busy || isRefreshing || !!progress || manifest?.library.id !== route.id
                  }
                  onDelete={(path) => {
                    const file = manifest?.files.find((entry) => entry.path === path);
                    if (manifest && file) requestDelete(manifest.library, file);
                  }}
                />
              ) : (
                <p className="muted tree-empty">
                  {projectError
                    ? '目录读取失败，可在右侧重试'
                    : manifest
                      ? '还没有文件'
                      : '正在读取目录…'}
                </p>
              )}
            </div>
            <div className="file-panel-bottom">
              <span>
                {manifest?.library.kind === 'notes'
                  ? `${noteFiles.length} 篇笔记${assetFiles.length > 0 ? ` · ${assetFiles.length} 附件` : ''}`
                  : `${manifest?.files.length || 0} 个文件`}
              </span>
              {manifest?.library.kind === 'notes' && (
                <button
                  title="设置云端同步"
                  aria-label="设置云端同步"
                  className="icon-button"
                  disabled={offline}
                  onClick={() => {
                    setToken('');
                    setModal('connect');
                  }}
                >
                  <Link2 size={16} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label="更新项目内容"
                title="用 ZIP 更新当前项目"
                disabled={offline || !manifest}
                onClick={() => {
                  setImportTarget(route.id!);
                  setModal('import');
                }}
              >
                <UploadCloud size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="删除项目"
                title="删除整个项目"
                disabled={
                  !manifest ||
                  manifest.library.id !== route.id ||
                  busy ||
                  isRefreshing ||
                  !!progress
                }
                onClick={() => manifest && requestDelete(manifest.library)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </aside>
          {showTree && <div className="tree-scrim" onClick={() => setShowTree(false)} />}
          {route.id && !focused && !showTree && !showSearch && !showOutline && !modal && (
            <button
              className="reader-directory-shortcut"
              aria-label="浏览文件目录"
              aria-controls="project-file-tree"
              aria-expanded={showTree}
              onClick={() => setShowTree(true)}
            >
              <FolderOpen size={19} />
              <span>目录</span>
            </button>
          )}
          <section className="document">
            <MobileReaderToolbar
              path={route.file}
              libraryName={manifest?.library.name}
              directoryOpen={showTree}
              isMarkdown={isMarkdown}
              wrap={wrap}
              refreshing={isRefreshing}
              offline={offline}
              progress={progress}
              offlineSaved={offlineSaved}
              hasManifest={!!manifest}
              home={() => setRouteTo(route.kind)}
              directory={() => setShowTree(true)}
              focus={enterFocus}
              dark={dark}
              themeMenuOpen={themeMenuOpen}
              chooseTheme={() => setThemeMenuOpen(true)}
              synchronize={() => void synchronize()}
              search={() => setShowSearch(true)}
              toggleWrap={() => setWrap(!wrap)}
              outline={() => setShowOutline(true)}
              saveOffline={() => void saveOffline()}
              account={() => setModal('account')}
            />
            <div className="document-toolbar">
              <button
                className="icon-button mobile-only"
                aria-label="打开目录"
                onClick={() => setShowTree(true)}
              >
                <Menu size={19} />
              </button>
              <div className="document-name">
                {isMarkdown ? <FileText size={16} /> : <FileCode2 size={16} />}
                <span>{route.file?.split('/').pop() || '选择文件开始阅读'}</span>
              </div>
              <div className="document-tools">
                <button
                  className="icon-button"
                  aria-label="专注阅读"
                  title="专注阅读"
                  onClick={enterFocus}
                >
                  <Maximize2 size={17} />
                </button>
                <button
                  className={`icon-button ${showSearch ? 'toggled' : ''}`}
                  aria-label="搜索项目内容"
                  onClick={() => setShowSearch(!showSearch)}
                >
                  <Search size={17} />
                </button>
                {!isMarkdown && (
                  <button
                    className={`icon-button ${wrap ? 'toggled' : ''}`}
                    aria-label="自动换行"
                    aria-pressed={wrap}
                    title="自动换行"
                    onClick={() => setWrap(!wrap)}
                  >
                    <WrapText size={18} />
                  </button>
                )}
                <button
                  className={`icon-button ${showOutline ? 'toggled' : ''}`}
                  aria-label="文件大纲"
                  title="文件大纲"
                  onClick={() => setShowOutline(!showOutline)}
                >
                  <Layers3 size={17} />
                </button>
                <button
                  aria-label={progress || (offlineSaved ? '已保存离线' : '保存离线')}
                  title={offlineSaved ? '已保存离线' : '保存整个项目供离线阅读'}
                  className={`button compact ${offlineSaved ? 'saved' : ''}`}
                  disabled={offline || !!progress || !manifest}
                  onClick={() => void saveOffline()}
                >
                  {progress ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : offlineSaved ? (
                    <Check size={15} />
                  ) : (
                    <ArrowDownToLine size={15} />
                  )}
                  <span>{progress || (offlineSaved ? '已保存离线' : '保存离线')}</span>
                </button>
              </div>
            </div>
            {showSearch && (
              <div className="project-search">
                <form onSubmit={performSearch}>
                  <Search size={17} />
                  <input
                    autoFocus
                    aria-label="项目内全文搜索"
                    placeholder="搜索整个项目的内容…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button className="button primary compact" disabled={searchBusy || !query.trim()}>
                    {searchBusy ? '搜索中' : '搜索'}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭搜索"
                    onClick={() => setShowSearch(false)}
                  >
                    <X size={17} />
                  </button>
                </form>
                {results && (
                  <div className="search-results">
                    {results.length ? (
                      results.map((result, i) => (
                        <button key={i} onClick={() => openFile(result.path, result.line)}>
                          <span>
                            {result.path}
                            <small>第 {result.line} 行</small>
                          </span>
                          <code>{result.snippet}</code>
                        </button>
                      ))
                    ) : (
                      <p>没有找到匹配内容。</p>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="document-body">
              <ReaderWorkspace
                key={user.id}
                user={user}
                manifest={manifest}
                projectError={projectError}
                retryProject={() => void loadManifest()}
                libraryKind={route.kind}
                libraryId={route.id}
                deletedLibraryId={deletedLibraryId}
                deletedFile={deletedFile}
                path={route.file}
                line={route.line}
                heading={route.heading}
                jump={jump}
                theme={theme}
                setTheme={setTheme}
                wrap={wrap}
                offline={offline}
                navigate={setRouteTo}
                notify={notify}
                onOutline={setOutline}
                handleError={handleError}
                connect={() => {
                  setToken('');
                  setModal('connect');
                }}
              />
              {showOutline && (
                <aside className="outline">
                  <div className="panel-title">
                    {isMarkdown ? '本页目录' : '符号速览'}
                    <button
                      className="icon-button"
                      aria-label="关闭大纲"
                      onClick={() => setShowOutline(false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  {isMarkdown ? (
                    outline.length ? (
                      outline.map((item) => (
                        <button
                          key={item.line}
                          className="heading-item"
                          style={{ paddingLeft: 12 + ((item.level || 1) - 1) * 10 }}
                          onClick={() => openFile(route.file!, item.line)}
                        >
                          {item.name}
                        </button>
                      ))
                    ) : (
                      <p className="outline-hint">当前笔记没有标题。</p>
                    )
                  ) : (
                    <>
                      <p className="outline-hint">按文本识别，仅供快速定位</p>
                      {outline.map((item) => (
                        <button key={item.line} onClick={() => openFile(route.file!, item.line)}>
                          {item.name}
                          <small>{item.line}</small>
                        </button>
                      ))}
                      {!outline.length && (
                        <p className="outline-hint">当前文件暂无可识别的符号。</p>
                      )}
                    </>
                  )}
                </aside>
              )}
            </div>
            <footer className="document-status">
              <span>{route.file || '只读空间'}</span>
              <div>
                <span>{currentFile ? formatBytes(currentFile.size) : ''}</span>
                <span>UTF-8</span>
                <span>
                  <ShieldCheck size={12} />{' '}
                  {manifest?.library.kind === 'notes' ? '原文保护' : '只读'}
                </span>
              </div>
            </footer>
          </section>
        </div>
      </main>
      {focused && route.id && (
        <button
          className="reader-focus-exit"
          onClick={() => setFocused(false)}
          aria-label="退出专注阅读"
        >
          <Minimize2 size={17} />
          <span>退出专注</span>
        </button>
      )}
      <nav className="mobile-nav">
        <button
          className={route.kind === 'notes' ? 'active' : ''}
          onClick={() => setRouteTo('notes')}
        >
          <BookOpen size={20} />
          学习笔记
        </button>
        <button
          className={route.kind === 'code' ? 'active' : ''}
          onClick={() => setRouteTo('code')}
        >
          <Code2 size={20} />
          代码项目
        </button>
        <button aria-label="打开七七" aria-haspopup="dialog" onClick={openQiqi}>
          <MessageCircle size={20} />
          七七
        </button>
      </nav>
      <QiqiPanel key={user.id} userId={user.id} notify={notify} />
      {themeMenuOpen &&
        createPortal(
          <ReadingThemeMenu
            theme={theme}
            select={setTheme}
            close={() => setThemeMenuOpen(false)}
          />,
          document.body,
        )}
      {modal === 'import' && (
        <Modal
          title={route.kind === 'code' ? '导入代码项目' : '导入笔记库'}
          close={() => !busy && setModal(null)}
        >
          <form onSubmit={doImport}>
            <label className="field">
              导入到
              <select
                aria-label="导入目标"
                value={importTarget}
                onChange={(event) => setImportTarget(event.target.value)}
              >
                <option value="auto">自动匹配同名项目</option>
                <option value="new">新建项目</option>
                {libraries
                  .filter((lib) => !lib.localOnly && lib.kind === route.kind)
                  .map((lib) => (
                    <option key={lib.id} value={lib.id}>
                      {lib.name} · {lib.fileCount} 个文件 · {relativeDate(lib.updatedAt)}
                    </option>
                  ))}
              </select>
            </label>
            {ambiguousImport ? (
              <p role="alert">存在多个同名项目，请选择要更新的项目。</p>
            ) : (
              updateTarget && (
                <p className="modal-intro">
                  更新「{updateTarget.name}」。ZIP 将替换项目文件，批注和编辑版保留。
                </p>
              )
            )}
            <label className="field">
              名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="留空则使用 ZIP 文件名"
                maxLength={100}
              />
            </label>
            <label
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files[0]) setZip(e.dataTransfer.files[0]);
              }}
            >
              <UploadCloud size={34} />
              <strong>{zip ? zip.name : '选择或拖入一个 ZIP 文件'}</strong>
              <span>{zip ? formatBytes(zip.size) : '支持 .zip 格式'}</span>
              <input
                aria-label="选择 ZIP 文件"
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setZip(e.target.files?.[0] || null)}
              />
            </label>
            <p className="form-hint">
              ZIP 最多 24 MB，解压后最多 64 MB / 4000 个文件。自动略过 .git、node_modules 和
              Obsidian 配置目录。
            </p>
            <button className="button primary wide" disabled={busy || !zip || ambiguousImport}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <UploadCloud size={17} />}{' '}
              {busy ? '正在处理…' : updateTarget ? '更新项目' : '导入并开始阅读'}
            </button>
          </form>
        </Modal>
      )}
      {modal === 'connect' && (
        <Modal
          title="设置云端同步"
          close={() => {
            if (busy) return;
            setModal(null);
            setToken('');
          }}
        >
          <p className="modal-intro">电脑上传笔记到 CodeSip 服务，手机从服务端读取。</p>
          <div
            className="sync-route"
            role="img"
            aria-label="同步路径：电脑 Obsidian → CodeSip 服务端 → 手机阅读"
          >
            <div>
              <Laptop size={21} />
              <strong>电脑</strong>
              <small>Obsidian</small>
            </div>
            <ArrowRight size={16} aria-hidden="true" />
            <div>
              <Cloud size={21} />
              <strong>服务端</strong>
              <small>CodeSip</small>
            </div>
            <ArrowRight size={16} aria-hidden="true" />
            <div>
              <Smartphone size={21} />
              <strong>手机</strong>
              <small>阅读副本</small>
            </div>
          </div>
          <p className="sync-setup-hint">Obsidian 运行时上传；电脑关机后，已上传的笔记仍可阅读。</p>
          {syncLibrary ? (
            <p className="sync-destination">
              同步到：<strong>{syncLibrary.name}</strong>
            </p>
          ) : (
            <label className="field">
              新笔记库名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="我的学习笔记"
              />
            </label>
          )}
          <ol className="connect-steps">
            <li>
              <span>1</span>
              <div>
                <strong>在电脑安装插件</strong>
                <p>
                  下载后解压，把 codesip-sync 文件夹放进笔记库的 .obsidian/plugins，重新加载
                  Obsidian 并启用。
                </p>
                <a className="button secondary compact" href="/codesip-obsidian.zip" download>
                  <Download size={15} />
                  下载 CodeSip 插件
                </a>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>生成并复制连接信息</strong>
                <p>在电脑的 CodeSip Sync 设置中粘贴，选择笔记目录，再点击「同步到 CodeSip」。</p>
                {token ? (
                  <>
                    <textarea
                      className="connection-token"
                      aria-label="Obsidian 连接信息"
                      value={token}
                      readOnly
                      rows={4}
                    />
                    <button
                      className="button primary compact"
                      onClick={() =>
                        navigator.clipboard
                          .writeText(token)
                          .then(() => notify('连接信息已复制'))
                          .catch(() => notify('请手动选中并复制连接信息'))
                      }
                    >
                      <Copy size={15} />
                      复制连接信息
                    </button>
                  </>
                ) : (
                  <button
                    className="button primary compact"
                    disabled={busy || offline}
                    onClick={() => void connect()}
                  >
                    {busy ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}
                    生成连接信息
                  </button>
                )}
              </div>
            </li>
          </ol>
          {token && syncLibrary && (
            <button
              className="button secondary compact"
              onClick={() => {
                setModal(null);
                setRouteTo('notes', syncLibrary.id);
              }}
            >
              打开笔记库
            </button>
          )}
          {syncLibrary && (
            <button
              className="button text danger"
              disabled={offline || busy}
              onClick={async () => {
                try {
                  await api(`/libraries/${syncLibrary.id}/token`, { method: 'DELETE' });
                  setToken('');
                  notify('已撤销此笔记库的插件连接');
                } catch (e) {
                  handleError(e);
                }
              }}
            >
              撤销此笔记库的连接
            </button>
          )}
          <p className="form-hint">
            重新生成会让旧连接失效。连接信息含上传凭据，请仅粘贴到你自己的插件中。
          </p>
        </Modal>
      )}
      {modal === 'delete' && deleteTarget && (
        <Modal
          title={deleteTarget.file ? '删除文件' : '删除项目'}
          close={() => !busy && setModal(null)}
        >
          <div className="delete-target">
            <small>
              {deleteTarget.file
                ? deleteTarget.library.name
                : `${deleteTarget.library.fileCount} 个文件 · ${formatBytes(deleteTarget.library.totalBytes)}`}
            </small>
            <strong>{deleteTarget.file?.path || deleteTarget.library.name}</strong>
          </div>
          <p className="modal-intro">
            {deleteTarget.file
              ? '删除 CodeSip 中的这份文件和本机离线副本，批注与编辑版保留。电脑原文件仍在，再次同步或导入时可能重新出现。'
              : '删除整个项目及本机离线副本，项目内的批注和编辑版也会删除。电脑原文件保留，已有插件连接会失效。'}
          </p>
          {deleteError && (
            <p className="delete-feedback" role="alert">
              {deleteError}
            </p>
          )}
          <div className="modal-buttons">
            <button className="button secondary" disabled={busy} onClick={() => setModal(null)}>
              取消
            </button>
            <button
              className="button danger-fill"
              disabled={busy}
              onClick={() => void removeSelected()}
            >
              {busy ? '删除中…' : deleteTarget.file ? '确认删除文件' : '确认删除项目'}
            </button>
          </div>
        </Modal>
      )}
      {modal === 'account' && user && (
        <Modal title="当前账号" close={() => setModal(null)}>
          <div className="account-dialog-content">
            <div className="account-info-card">
              <div className="avatar-large">
                <img src="/qiqi-avatar.jpg" alt="七七头像" />
              </div>
              <div className="account-details">
                <strong className="account-username">{user.username}</strong>
                <span className="account-status">
                  {offline ? '离线模式' : '已连接 CodeSip 服务'}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setModal(null);
                window.dispatchEvent(new Event('codesip:check-update'));
              }}
            >
              <RefreshCw size={16} /> 检查应用更新
            </button>
            <p className="form-hint">本机离线副本和未同步草稿会清除，已同步内容保留。</p>
            <div className="modal-buttons">
              <button type="button" className="button secondary" onClick={() => setModal(null)}>
                取消
              </button>
              <button
                type="button"
                className="button danger-fill"
                onClick={async () => {
                  setModal(null);
                  if (!offline) await api('/auth/logout', { method: 'POST' }).catch(() => {});
                  await logoutLocal();
                }}
              >
                退出登录
              </button>
            </div>
          </div>
        </Modal>
      )}
      {toast}
    </div>
  );
}
