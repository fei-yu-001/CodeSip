import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
} from 'react';
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
  Moon,
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
import type { Library, LibraryKind, Manifest, SearchResult, User } from '../../shared/types';
import {
  api,
  HttpError,
  cached,
  save,
  clearPrivateData,
  cachedLibraries,
  manifestKey,
  fileBlob,
  downloadLibrary,
  formatBytes,
  relativeDate,
  removeLibraryCache,
} from './api';
import { readTheme, type ReaderTheme, type OutlineItem } from './readerState';
import { navigateHash, useDismissibleLayer } from './readerNavigation';
import Modal from './Modal';
import './sync-setup.css';
const CodeReader = lazy(() => import('./CodeReader'));

const MarkdownReader = lazy(() => import('./MarkdownReader'));

type Route = { kind: LibraryKind; id?: string; file?: string; line?: number };
const readRoute = (): Route => {
  const [path, query] = location.hash.slice(1).split('?');
  const [kind, id] = path.split('/');
  const params = new URLSearchParams(query);
  return {
    kind: kind === 'notes' ? 'notes' : 'code',
    id: id || undefined,
    file: params.get('file') || undefined,
    line: params.has('line') ? Math.max(1, Math.floor(Number(params.get('line')) || 1)) : undefined,
  };
};
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
  depth = 0,
}: {
  nodes: TreeNode[];
  active?: string;
  onOpen: (s: string) => void;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.file ? (
          <button
            key={node.path}
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
        ) : (
          <details key={node.path} open={depth < 2}>
            <summary style={{ paddingLeft: 12 + depth * 16 }}>
              <ChevronRight size={13} />
              <Folder size={15} />
              <span>{node.name}</span>
            </summary>
            <Tree nodes={node.children} active={active} onOpen={onOpen} depth={depth + 1} />
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
    [libraries, setLibraries] = useState<Library[]>([]),
    [manifest, setManifest] = useState<Manifest>(),
    [text, setText] = useState(''),
    [fileError, setFileError] = useState(''),
    [busy, setBusy] = useState(false),
    [fileBusy, setFileBusy] = useState(false);
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
    [token, setToken] = useState(''),
    [createdSyncLibrary, setCreatedSyncLibrary] = useState<Library>(),
    [progress, setProgress] = useState(''),
    [isRefreshing, setIsRefreshing] = useState(false),
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
  const [theme, setTheme] = useState<ReaderTheme>(readTheme);
  const dark = theme === 'warm-slate';
  const [jump, setJump] = useState(0);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [showEmptyLibs, setShowEmptyLibs] = useState(false);
  const [notesOnly, setNotesOnly] = useState(true);
  const [wrap, setWrap] = useState(localStorage.getItem('codesip:wrap') !== 'false'),
    [offlineSaved, setOfflineSaved] = useState(false),
    [blobUrl, setBlobUrl] = useState('');
  const notify = useCallback((value: string) => setMessage(value), []);
  const searchSeq = useRef(0);
  const manifestSeq = useRef(0);
  const loadedFileRef = useRef<{
    userId: string;
    libraryId: string;
    path: string;
    hash: string;
  } | null>(null);
  const imageObjectUrlRef = useRef('');
  const releaseImageObjectUrl = useCallback(() => {
    if (imageObjectUrlRef.current) {
      URL.revokeObjectURL(imageObjectUrlRef.current);
      imageObjectUrlRef.current = '';
    }
  }, []);
  useEffect(() => releaseImageObjectUrl, [releaseImageObjectUrl]);
  const routeScopeRef = useRef({ kind: route.kind, id: route.id });
  routeScopeRef.current = { kind: route.kind, id: route.id };
  const setRouteTo = useCallback((kind: LibraryKind, id?: string, file?: string, line?: number) => {
    const query = file
      ? `?file=${encodeURIComponent(file)}${line !== undefined ? `&line=${line}` : ''}`
      : '';
    navigateHash(`${kind}${id ? '/' + id : ''}${query}`);
  }, []);
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
  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api<{ libraries: Library[] }>('/libraries');
      setLibraries(data.libraries);
      await save(`${user.id}:libraries`, data.libraries);
      setOffline(false);
    } catch (e) {
      if (!(e instanceof HttpError)) {
        setLibraries((await cachedLibraries(user)) || []);
        setOffline(true);
      } else handleError(e);
    }
  }, [user, handleError]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const online = () => {
      void refresh();
    };
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
    if (!user || !route.id) {
      setManifest(undefined);
      return;
    }
    try {
      const data = await api<Manifest>(`/libraries/${route.id}/manifest`);
      if (seq !== manifestSeq.current) return;
      setManifest(data);
      setOffline(false);
    } catch (e) {
      if (seq !== manifestSeq.current) return;
      if (!(e instanceof HttpError)) {
        const data = await cached<Manifest>(manifestKey(user, route.id));
        if (seq !== manifestSeq.current) return;
        if (data) {
          setManifest(data);
          setOffline(true);
        } else {
          setManifest(undefined);
          notify('这个项目尚未下载，请联网后打开');
        }
      } else handleError(e);
    }
  }, [user, route.id, handleError, notify]);
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
  useEffect(() => {
    if (!user || !manifest || !route.file) {
      loadedFileRef.current = null;
      releaseImageObjectUrl();
      setText('');
      setBlobUrl('');
      setFileError('');
      setFileBusy(false);
      return;
    }
    const file = manifest.files.find((f) => f.path === route.file);
    if (!file) {
      loadedFileRef.current = null;
      releaseImageObjectUrl();
      setText('');
      setBlobUrl('');
      setOutline([]);
      setFileError('这份文件已移动或删除，请从目录重新选择');
      setFileBusy(false);
      return;
    }
    const loaded = loadedFileRef.current;
    if (
      loaded &&
      loaded.userId === user.id &&
      loaded.libraryId === manifest.library.id &&
      loaded.path === file.path &&
      loaded.hash === file.hash
    ) {
      return;
    }
    let active = true;
    const controller = new AbortController();
    loadedFileRef.current = null;
    releaseImageObjectUrl();
    setText('');
    setBlobUrl('');
    setFileBusy(true);
    setFileError('');
    setOutline([]);
    (async () => {
      try {
        const blob = await fileBlob(user, manifest.library.id, file, !offline, controller.signal);
        const value = file.isText ? await blob.text() : '';
        if (!active || controller.signal.aborted) return;
        loadedFileRef.current = {
          userId: user.id,
          libraryId: manifest.library.id,
          path: file.path,
          hash: file.hash,
        };
        setText(value);
        if (file.mediaType.startsWith('image/')) {
          releaseImageObjectUrl();
          const objectUrl = URL.createObjectURL(blob);
          imageObjectUrlRef.current = objectUrl;
          setBlobUrl(objectUrl);
        } else {
          setBlobUrl('');
        }
        try {
          localStorage.setItem(`codesip:reading:${user.id}:${manifest.library.id}`, file.path);
        } catch {
          /* Reading remains available. */
        }
      } catch (e: any) {
        if (!active || controller.signal.aborted || e?.name === 'AbortError') return;
        loadedFileRef.current = null;
        setFileError(e.message);
        if (e instanceof HttpError && e.status === 401) handleError(e);
      } finally {
        if (active) setFileBusy(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [user, manifest, route.file, offline, handleError, releaseImageObjectUrl]);
  const visibleLibraries = useMemo(
    () =>
      libraries.filter(
        (l) => l.kind === route.kind && l.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [libraries, route.kind, query],
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
      if (line !== undefined) setJump((value) => value + 1);
      const { kind, id } = routeScopeRef.current;
      setRouteTo(kind, id, path, line);
      setShowSearch(false);
      setShowTree(false);
      setShowOutline(false);
    },
    [setRouteTo],
  );
  async function doImport(event: FormEvent) {
    event.preventDefault();
    if (!zip) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', zip);
      const data = await api<{ library: Library }>(
        `/import?kind=${route.kind}&name=${encodeURIComponent(name.trim() || zip.name.replace(/\.zip$/i, ''))}`,
        { method: 'POST', body: form },
      );
      await refresh();
      setModal(null);
      setZip(null);
      setName('');
      setRouteTo(data.library.kind, data.library.id);
      notify('导入完成，开始阅读吧');
    } catch (e) {
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
        await refresh();
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
    if (!user || !manifest) return;
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
      if (offline) {
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
  async function removeLibrary() {
    if (!user || !manifest) return;
    setBusy(true);
    try {
      await api(`/libraries/${manifest.library.id}`, { method: 'DELETE' });
      await removeLibraryCache(user, manifest.library.id);
      setModal(null);
      setRouteTo(route.kind);
      await refresh();
      notify('已删除服务端副本，电脑上的原文件不受影响');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
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
    <div className={`app ${route.id ? 'reading' : ''}`}>
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">资料库</div>
        <nav>
          <button
            className={route.kind === 'code' ? 'selected' : ''}
            onClick={() => setRouteTo('code')}
          >
            <Code2 size={19} />
            代码项目<span>{libraries.filter((l) => l.kind === 'code').length}</span>
          </button>
          <button
            className={route.kind === 'notes' ? 'selected' : ''}
            onClick={() => setRouteTo('notes')}
          >
            <BookOpen size={19} />
            学习笔记<span>{libraries.filter((l) => l.kind === 'notes').length}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className="theme-switch"
            onClick={() => setTheme(theme === 'warm-slate' ? 'paper-light' : 'warm-slate')}
            aria-label="切换明暗主题"
          >
            {theme === 'warm-slate' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === 'warm-slate' ? '素笺暖白' : '松烟暖灰'}</span>
          </button>
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
                <span>{manifest?.library.name || '加载中…'}</span>
              </>
            )}
          </div>
          <div className="top-actions">
            {offline && (
              <span className="offline-label">
                <WifiOff size={14} /> 离线
              </span>
            )}
            <button
              className={`icon-button ${isRefreshing ? 'is-spinning' : ''}`}
              aria-label={isRefreshing ? '正在刷新' : '刷新'}
              title={isRefreshing ? '正在刷新…' : '刷新内容'}
              disabled={!!progress || isRefreshing}
              onClick={async () => {
                if (isRefreshing || progress) return;
                setIsRefreshing(true);
                try {
                  await refresh();
                  if (route.id) await loadManifest();
                  try {
                    window.dispatchEvent(new Event('codesip:annotations-refresh'));
                  } catch {
                    /* ignore */
                  }
                  notify('已刷新最新内容');
                } catch {
                  notify('刷新失败，请检查网络');
                } finally {
                  setIsRefreshing(false);
                }
              }}
            >
              <RefreshCw size={17} className={isRefreshing ? 'spin-icon' : ''} />
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
        {!route.id ? (
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
                  {libraries.filter((library) => library.kind === route.kind).length}
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
                        <button
                          className="library-card"
                          key={library.id}
                          onClick={() => setRouteTo(library.kind, library.id)}
                        >
                          <div className="card-top">
                            <div className={`project-icon shade-${i % 3}`}>
                              {library.kind === 'code' ? (
                                <FolderOpen size={24} />
                              ) : (
                                <BookOpen size={23} />
                              )}
                            </div>
                            <ArrowRight size={19} />
                          </div>
                          <h3>{library.name}</h3>
                          <p>
                            {library.fileCount} 个文件 · {formatBytes(library.totalBytes)}
                          </p>
                          <div className="card-divider" />
                          <div className="card-footer">
                            <span>{relativeDate(library.updatedAt)}</span>
                          </div>
                        </button>
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
                            <button
                              className="library-card"
                              key={library.id}
                              onClick={() => setRouteTo(library.kind, library.id)}
                            >
                              <div className="card-top">
                                <div className={`project-icon shade-${i % 3}`}>
                                  {library.kind === 'code' ? (
                                    <FolderOpen size={24} />
                                  ) : (
                                    <BookOpen size={23} />
                                  )}
                                </div>
                                <ArrowRight size={19} />
                              </div>
                              <h3>{library.name}</h3>
                              <p>
                                {library.fileCount} 个文件 · {formatBytes(library.totalBytes)}
                              </p>
                              <div className="card-divider" />
                              <div className="card-footer">
                                <span>{relativeDate(library.updatedAt)}</span>
                              </div>
                            </button>
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
                            await refresh();
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
            </section>
          </div>
        ) : (
          <div className="reader-layout">
            <aside className={`file-panel ${showTree ? 'open' : ''}`}>
              <div className="panel-title">
                <span>
                  <Layers3 size={15} /> 项目目录
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
                  <Tree nodes={tree} active={route.file} onOpen={openFile} />
                ) : (
                  <p className="muted tree-empty">{manifest ? '还没有文件' : '正在读取目录…'}</p>
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
                  aria-label="删除项目"
                  title="删除服务端副本"
                  disabled={offline}
                  onClick={() => setModal('delete')}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </aside>
            {showTree && <div className="tree-scrim" onClick={() => setShowTree(false)} />}
            <section className="document">
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
                    <button
                      className="button primary compact"
                      disabled={searchBusy || !query.trim()}
                    >
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
                <Suspense fallback={<div className="reader-empty">正在打开阅读器…</div>}>
                  {fileBusy ? (
                    <div className="reader-empty">
                      <LoaderCircle className="spin" size={25} />
                      <p>正在加载…</p>
                    </div>
                  ) : fileError ? (
                    <div className="reader-empty">
                      <CloudOff size={32} />
                      <p>{fileError}</p>
                      <button className="button secondary" onClick={() => void loadManifest()}>
                        刷新文件清单
                      </button>
                    </div>
                  ) : !route.file ? (
                    <div className="reader-empty">
                      <BookOpen size={38} />
                      <h3>{manifest?.library.kind === 'notes' ? '暂无笔记' : '选择文件'}</h3>
                      <p>
                        {manifest?.library.kind === 'notes'
                          ? '在电脑的 Obsidian 插件中上传笔记，再在这里阅读。'
                          : '从目录中选择要查看的文件。'}
                      </p>
                      {manifest?.library.kind === 'notes' && (
                        <button
                          className="button primary"
                          disabled={offline}
                          onClick={() => {
                            setToken('');
                            setModal('connect');
                          }}
                        >
                          <Link2 size={16} />
                          设置云端同步
                        </button>
                      )}
                    </div>
                  ) : isMarkdown && currentFile?.isText ? (
                    <MarkdownReader
                      key={`${user.id}:${manifest!.library.id}:${route.file}`}
                      theme={theme}
                      setTheme={setTheme}
                      line={route.line}
                      jump={jump}
                      onOutline={setOutline}
                      text={text}
                      path={route.file}
                      user={user}
                      manifest={manifest!}
                      offline={offline}
                      navigate={openFile}
                      notify={notify}
                    />
                  ) : blobUrl ? (
                    <div className="image-reader">
                      <img src={blobUrl} alt={route.file} />
                    </div>
                  ) : currentFile?.isText ? (
                    <CodeReader
                      key={`${user.id}:${manifest!.library.id}:${route.file}`}
                      identity={{
                        userId: user.id,
                        libraryId: manifest!.library.id,
                        path: route.file,
                      }}
                      notify={notify}
                      text={text}
                      path={route.file}
                      dark={dark}
                      wrap={wrap}
                      line={route.line}
                      jump={jump}
                      onOutline={setOutline}
                    />
                  ) : (
                    <div className="reader-empty">
                      <File size={35} />
                      <h3>这个文件暂不支持预览</h3>
                      <p>可以保存离线副本，或在电脑上查看。</p>
                    </div>
                  )}
                </Suspense>
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
        )}
      </main>
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
        <button
          className={themeMenuOpen ? 'active' : ''}
          onClick={() => setThemeMenuOpen(!themeMenuOpen)}
        >
          {theme === 'warm-slate' ? <Moon size={20} /> : <Sun size={20} />}
          阅读主题
        </button>
      </nav>

      {themeMenuOpen &&
        createPortal(
          <>
            <div className="theme-drawer-backdrop" onClick={() => setThemeMenuOpen(false)} />
            <div className="theme-drawer">
              <div className="theme-drawer-handle" />
              <div className="theme-drawer-title">切换阅读主题</div>
              <div className="theme-drawer-options">
                <button
                  type="button"
                  className={`theme-drawer-item ${theme === 'paper-light' ? 'active' : ''}`}
                  onClick={() => {
                    setTheme('paper-light');
                    setThemeMenuOpen(false);
                  }}
                >
                  <div className="theme-dot dot-paper" />
                  <div className="theme-item-text">
                    <strong>素笺暖白</strong>
                    <span>棉纸柔和底，日光讲义质感</span>
                  </div>
                </button>
                <button
                  type="button"
                  className={`theme-drawer-item ${theme === 'warm-slate' ? 'active' : ''}`}
                  onClick={() => {
                    setTheme('warm-slate');
                    setThemeMenuOpen(false);
                  }}
                >
                  <div className="theme-dot dot-slate" />
                  <div className="theme-item-text">
                    <strong>松烟暖灰</strong>
                    <span>夜间低对比护眼暗调</span>
                  </div>
                </button>
                <button
                  type="button"
                  className={`theme-drawer-item ${theme === 'sepia-parchment' ? 'active' : ''}`}
                  onClick={() => {
                    setTheme('sepia-parchment');
                    setThemeMenuOpen(false);
                  }}
                >
                  <div className="theme-dot dot-sepia" />
                  <div className="theme-item-text">
                    <strong>羊皮纸棕</strong>
                    <span>沉浸古籍温润色调</span>
                  </div>
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
      {modal === 'import' && (
        <Modal
          title={route.kind === 'code' ? '导入代码项目' : '导入笔记库'}
          close={() => !busy && setModal(null)}
        >
          <form onSubmit={doImport}>
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
            <button className="button primary wide" disabled={busy || !zip}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <UploadCloud size={17} />}{' '}
              {busy ? '正在导入…' : '导入并开始阅读'}
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
      {modal === 'delete' && (
        <Modal title="删除服务端副本" close={() => !busy && setModal(null)}>
          <p className="modal-intro">
            确认删除「{manifest?.library.name}
            」及本机的离线副本？电脑上的原文件会保留，已有插件连接会失效。
          </p>
          <div className="modal-buttons">
            <button className="button secondary" onClick={() => setModal(null)}>
              取消
            </button>
            <button
              className="button danger-fill"
              disabled={busy}
              onClick={() => void removeLibrary()}
            >
              {busy ? '删除中…' : '确认删除'}
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
