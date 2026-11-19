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
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudOff,
  Code2,
  Coffee,
  Copy,
  Download,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
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
const CodeReader = lazy(() => import('./CodeReader'));

const MarkdownReader = lazy(() => import('./MarkdownReader'));

type Route = { kind: LibraryKind; id?: string; file?: string; line: number };
const readRoute = (): Route => {
  const [path, query] = location.hash.slice(1).split('?');
  const [kind, id] = path.split('/');
  const params = new URLSearchParams(query);
  return {
    kind: kind === 'notes' ? 'notes' : 'code',
    id: id || undefined,
    file: params.get('file') || undefined,
    line: Math.max(1, Number(params.get('line')) || 1),
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
        <Brand />
        <div className="auth-copy">
          <span className="eyebrow">
            <span /> YOUR POCKET READING ROOM
          </span>
          <h1>
            好代码，
            <br />
            值得慢慢读<span>。</span>
          </h1>
          <p>
            把项目和学习笔记装进口袋。
            <br />
            一杯咖啡的时间，离理解再近一点。
          </p>
          <div className="auth-benefits">
            <span>
              <Code2 size={18} /> 读代码
            </span>
            <span>
              <BookOpen size={18} /> 理思路
            </span>
            <span>
              <Cloud size={18} /> 随时看
            </span>
          </div>
        </div>
        <div className="auth-footer">
          少一点切换，多一点专注。<span>CodeSip / 01</span>
        </div>
      </section>
      <section className="auth-form-area">
        <div className="auth-card">
          <div className="auth-mark">
            <Coffee size={29} />
          </div>
          <span className="eyebrow">MAKE ROOM FOR IDEAS</span>
          <h2>{setup ? '建立你的阅读空间' : '欢迎回来'}</h2>
          <p>
            {setup ? '创建一个账号，让电脑与手机在这里相遇。' : '登录后，接着上次的思路往下读。'}
          </p>
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
              {setup ? '创建阅读空间' : '进入 CodeSip'}
              <ArrowRight size={17} />
            </button>
          </form>
          <div className="auth-security">
            <ShieldCheck size={14} /> 代码和笔记保存在你的独立服务中
          </div>
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
            {/\.md$/i.test(node.name) ? <FileText size={15} /> : <FileCode2 size={15} />}
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
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const getFocusable = () =>
      Array.from(
        root?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,textarea,a[href],[tabindex="0"]',
        ) || [],
      );
    getFocusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const elements = getFocusable();
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-scrim" onClick={close}>
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
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
  const [modal, setModal] = useState<'import' | 'connect' | 'delete' | null>(null),
    [name, setName] = useState(''),
    [zip, setZip] = useState<File | null>(null),
    [token, setToken] = useState(''),
    [progress, setProgress] = useState(''),
    [outline, setOutline] = useState<{ name: string; line: number }[]>([]);
  const [dark, setDark] = useState(localStorage.getItem('codesip:theme') === 'dark'),
    [wrap, setWrap] = useState(localStorage.getItem('codesip:wrap') === 'true'),
    [offlineSaved, setOfflineSaved] = useState(false),
    [blobUrl, setBlobUrl] = useState('');
  const notify = useCallback((value: string) => setMessage(value), []);
  const searchSeq = useRef(0);
  const manifestSeq = useRef(0);
  const setRouteTo = (kind: LibraryKind, id?: string, file?: string, line = 1) => {
    const query = file ? `?file=${encodeURIComponent(file)}${line > 1 ? `&line=${line}` : ''}` : '';
    location.hash = `${kind}${id ? '/' + id : ''}${query}`;
  };
  const logoutLocal = useCallback(async () => {
    manifestSeq.current++;
    await clearPrivateData();
    setUser(null);
    setLibraries([]);
    setManifest(undefined);
    location.hash = '';
  }, []);
  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof HttpError && error.status === 401) {
        void logoutLocal();
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
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('codesip:theme', dark ? 'dark' : 'light');
  }, [dark]);
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
            if (e instanceof HttpError && e.status === 401) await clearPrivateData();
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
    if (!manifest || route.file || !manifest.files.length) return;
    const remembered = localStorage.getItem(`codesip:reading:${manifest.library.id}`);
    const target =
      manifest.files.find((f) => f.path === remembered) ||
      manifest.files.find((f) => /^readme\.md$/i.test(f.path)) ||
      manifest.files.find((f) => f.isText);
    if (target) setRouteTo(route.kind, route.id, target.path);
  }, [manifest, route.file]);
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
      setText('');
      setBlobUrl('');
      return;
    }
    let active = true;
    let objectUrl = '';
    setFileBusy(true);
    setFileError('');
    setOutline([]);
    const file = manifest.files.find((f) => f.path === route.file);
    if (!file) {
      setFileError('这份文件已移动或删除，请从目录重新选择');
      setFileBusy(false);
      return;
    }
    fileBlob(user, manifest.library.id, file, !offline)
      .then(async (blob) => {
        const value = file.isText ? await blob.text() : '';
        if (active) {
          setText(value);
          if (file.mediaType.startsWith('image/')) {
            objectUrl = URL.createObjectURL(blob);
            setBlobUrl(objectUrl);
          } else setBlobUrl('');
          localStorage.setItem(`codesip:reading:${manifest.library.id}`, file.path);
        }
      })
      .catch((e) => {
        if (active) {
          setFileError(e.message);
          if (e instanceof HttpError && e.status === 401) handleError(e);
        }
      })
      .finally(() => {
        if (active) setFileBusy(false);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [user, manifest, route.file, offline]);
  const visibleLibraries = useMemo(
    () =>
      libraries.filter(
        (l) => l.kind === route.kind && l.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [libraries, route.kind, query],
  );
  const tree = useMemo(
    () =>
      makeTree(
        (manifest?.files || [])
          .filter((f) => f.path.toLowerCase().includes(fileFilter.toLowerCase()))
          .map((f) => f.path),
      ),
    [manifest, fileFilter],
  );
  const currentFile = manifest?.files.find((f) => f.path === route.file);
  const isMarkdown = !!route.file && /\.md(?:own)?$/i.test(route.file);
  const openFile = (path: string, line = 1) => {
    setRouteTo(route.kind, route.id, path, line);
    setShowSearch(false);
    setShowTree(false);
  };
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
      let lib = manifest?.library;
      if (!lib || lib.kind !== 'notes') {
        lib = (
          await api<{ library: Library }>('/libraries', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim() || '我的学习笔记', kind: 'notes' }),
          })
        ).library;
        await refresh();
        setRouteTo('notes', lib.id);
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
        <div className="workspace-label">
          我的阅读空间 <span>PERSONAL</span>
        </div>
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
        <div className="sidebar-note">
          <span className="tiny-label">A LITTLE EVERY DAY</span>
          <Coffee size={28} />
          <p>今天，也读懂一点点。</p>
          <span>让知识从屏幕走进脑海。</span>
        </div>
        <div className="sidebar-bottom">
          <div className="server-state">
            <span className={offline ? 'dot offline' : 'dot'} />
            {offline ? '离线阅读模式' : '私人空间 · 已连接'}
            <button
              className="icon-button"
              onClick={() => setDark(!dark)}
              aria-label="切换明暗主题"
            >
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
          <div className="profile">
            <div className="avatar">{user.username[0].toUpperCase()}</div>
            <div>
              <strong>{user.username}</strong>
              <span>给自己留一杯代码的时间</span>
            </div>
            <button
              className="icon-button"
              aria-label="退出登录"
              onClick={async () => {
                if (!offline) await api('/auth/logout', { method: 'POST' }).catch(() => {});
                await logoutLocal();
              }}
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
            {offline ? (
              <span className="offline-label">
                <WifiOff size={14} /> 离线
              </span>
            ) : (
              <span className="private-label">
                <ShieldCheck size={14} /> 私人阅读空间
              </span>
            )}
            <button
              className="icon-button"
              aria-label="刷新"
              disabled={!!progress}
              onClick={() => {
                void refresh();
                if (route.id) void loadManifest();
              }}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        {!route.id ? (
          <div className="dashboard">
            <section className="welcome">
              <div>
                <div className="eyebrow">
                  <span />
                  {route.kind === 'code'
                    ? 'READ. THINK. UNDERSTAND.'
                    : 'CAPTURE ON DESKTOP. READ ANYWHERE.'}
                </div>
                <h1>
                  {route.kind === 'code' ? (
                    <>
                      留一点时间，<span className="title-rest">读懂代码。</span>
                    </>
                  ) : (
                    <>
                      好想法，<span className="title-rest">随时翻一翻。</span>
                    </>
                  )}
                </h1>
                <p>
                  {route.kind === 'code'
                    ? '项目结构、关键实现，把复杂的思路慢慢理清。'
                    : '让电脑上的积累，成为口袋里随时可读的知识。'}
                </p>
              </div>
              <div className="welcome-art" aria-hidden="true">
                <div className="scene-contours" />
                <div className="art-orbit" />
                <div className="art-paper">
                  <span />
                  <span />
                  <span />
                  <Code2 size={32} />
                </div>
                <div className="art-cup">
                  <Coffee size={50} strokeWidth={1.3} />
                </div>
                <div className="art-dot" />
              </div>
            </section>
            <section className="library-section">
              <div className="section-heading">
                <div>
                  <h2>
                    {route.kind === 'code' ? '我的项目' : '我的笔记库'}
                    <span>{visibleLibraries.length}</span>
                  </h2>
                  <p>
                    {route.kind === 'code'
                      ? '从目录开始，循着思路往下读。'
                      : '你整理的知识，都在这里。'}
                  </p>
                </div>
                <div className="section-actions">
                  {route.kind === 'notes' && (
                    <button
                      className="button secondary"
                      disabled={offline}
                      onClick={() => {
                        setToken('');
                        setName('');
                        setModal('connect');
                      }}
                    >
                      <Link2 size={16} />
                      连接 Obsidian
                    </button>
                  )}
                  <button
                    className="button primary"
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
              <div className="library-toolbar">
                <label className="search-input">
                  <Search size={17} />
                  <input
                    aria-label="查找项目"
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
                <div className="library-grid">
                  {visibleLibraries.map((library, i) => (
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
                        {library.fileCount
                          ? `${library.fileCount} 个文件 · ${formatBytes(library.totalBytes)}`
                          : '等待第一篇笔记同步'}
                      </p>
                      <div className="card-divider" />
                      <div className="card-footer">
                        <span>
                          <span className="small-dot" />
                          {library.kind === 'code' ? '源码项目' : 'Markdown 笔记'}
                        </span>
                        <span>{relativeDate(library.updatedAt)}</span>
                      </div>
                    </button>
                  ))}
                  <button
                    className="add-card"
                    disabled={offline}
                    onClick={() => setModal('import')}
                  >
                    <span>
                      <Plus size={22} />
                    </span>
                    <strong>再带上一个{route.kind === 'code' ? '项目' : '笔记库'}</strong>
                    <p>导入 ZIP，随时接着读</p>
                  </button>
                </div>
              ) : (
                <div className="empty-library">
                  <div className="empty-icon">
                    {route.kind === 'code' ? <FolderOpen size={34} /> : <BookOpen size={34} />}
                  </div>
                  <h3>
                    {query
                      ? '还没有找到匹配的内容'
                      : route.kind === 'code'
                        ? '你的下一次理解，从这里开始'
                        : '把电脑上的好想法带在身边'}
                  </h3>
                  <p>
                    {query
                      ? '换一个关键词试试看。'
                      : route.kind === 'code'
                        ? '导入一个项目 ZIP，完整目录和源代码就能装进口袋。'
                        : '连接 Obsidian 自动同步，也可以直接导入笔记 ZIP。'}
                  </p>
                  {!query && (
                    <div className="empty-buttons">
                      <button
                        className="button primary"
                        disabled={offline}
                        onClick={() => setModal(route.kind === 'code' ? 'import' : 'connect')}
                      >
                        {route.kind === 'code' ? <UploadCloud size={17} /> : <Link2 size={17} />}{' '}
                        {route.kind === 'code' ? '导入第一个项目' : '连接 Obsidian'}
                      </button>
                      <button
                        className="button text"
                        disabled={busy || offline}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await api('/demo', { method: 'POST' });
                            await refresh();
                            notify('示例已准备好，随便逛逛');
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
            <footer className="dashboard-footer">
              <span>
                <Cloud size={15} /> 电脑整理，手机慢慢读
              </span>
              <span>
                CodeSip <span className="footer-dot">·</span> 饭后溜溜码
              </span>
            </footer>
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
              <div className="tree">
                {tree.length ? (
                  <Tree nodes={tree} active={route.file} onOpen={openFile} />
                ) : (
                  <p className="muted tree-empty">{manifest ? '还没有文件' : '正在读取目录…'}</p>
                )}
              </div>
              <div className="file-panel-bottom">
                <span>{manifest?.files.length || 0} 个文件</span>
                {manifest?.library.kind === 'notes' && (
                  <button
                    title="连接 Obsidian"
                    aria-label="连接 Obsidian"
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
                      <p>正在翻开这一页…</p>
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
                      <h3>
                        {manifest?.library.kind === 'notes'
                          ? '等待你的第一篇笔记'
                          : '从一个文件开始'}
                      </h3>
                      <p>
                        {manifest?.library.kind === 'notes'
                          ? '在电脑的 Obsidian 插件中连接这个笔记库。'
                          : '选择目录中的文件，慢慢读懂它。'}
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
                          连接 Obsidian
                        </button>
                      )}
                    </div>
                  ) : isMarkdown && currentFile?.isText ? (
                    <MarkdownReader
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
                      text={text}
                      path={route.file}
                      dark={dark}
                      wrap={wrap}
                      line={route.line}
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
                      text
                        .split('\n')
                        .filter((l) => /^#{1,6} /.test(l))
                        .map((l, i) => (
                          <div className="heading-item" key={i}>
                            {l.replace(/^#+ /, '')}
                          </div>
                        ))
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
                    <ShieldCheck size={12} /> 只读
                  </span>
                </div>
              </footer>
            </section>
          </div>
        )}
      </main>
      <nav className="mobile-nav">
        <button
          className={route.kind === 'code' ? 'active' : ''}
          onClick={() => setRouteTo('code')}
        >
          <Code2 size={20} />
          代码项目
        </button>
        <button
          className={route.kind === 'notes' ? 'active' : ''}
          onClick={() => setRouteTo('notes')}
        >
          <BookOpen size={20} />
          学习笔记
        </button>
        <button onClick={() => setDark(!dark)}>
          {dark ? <Sun size={20} /> : <Moon size={20} />}阅读主题
        </button>
        <button
          onClick={async () => {
            if (!offline) await api('/auth/logout', { method: 'POST' }).catch(() => {});
            await logoutLocal();
          }}
        >
          <LogOut size={20} />
          退出
        </button>
      </nav>
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
              <span>{zip ? formatBytes(zip.size) : '保留目录结构，源文件只供阅读'}</span>
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
          title="连接 Obsidian"
          close={() => {
            setModal(null);
            setToken('');
          }}
        >
          <p className="modal-intro">
            电脑负责整理，手机负责阅读。连接信息只授权这个笔记库，可随时撤销。
          </p>
          {!manifest && (
            <label className="field">
              笔记库名称
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
                <p>粘贴到插件设置，选择同步目录，然后点击「立即同步」。</p>
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
          {manifest?.library.kind === 'notes' && (
            <button
              className="button text danger"
              disabled={offline}
              onClick={async () => {
                try {
                  await api(`/libraries/${manifest.library.id}/token`, { method: 'DELETE' });
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
      {toast}
    </div>
  );
}
