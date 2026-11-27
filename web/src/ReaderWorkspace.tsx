import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CloudOff, File, LoaderCircle, X } from 'lucide-react';
import type { FileEntry, LibraryKind, Manifest, User } from '../../shared/types';
import { fileBlob, HttpError } from './api';
import type { OutlineItem, ReaderTheme } from './readerState';
import './reader-workspace.css';

const CodeReader = lazy(() => import('./CodeReader'));
const MarkdownReader = lazy(() => import('./MarkdownReader'));
interface OpenDocument {
  key: string;
  path: string;
  manifest: Manifest;
}
interface WorkspaceProps {
  user: User;
  manifest?: Manifest;
  deletedLibraryId?: string;
  libraryId?: string;
  path?: string;
  line?: number;
  heading?: string;
  jump: number;
  theme: ReaderTheme;
  setTheme: (theme: ReaderTheme) => void;
  wrap: boolean;
  offline: boolean;
  navigate: (
    kind: LibraryKind,
    id?: string,
    path?: string,
    line?: number,
    heading?: string,
  ) => void;
  notify: (message: string) => void;
  onOutline: (items: OutlineItem[]) => void;
  handleError: (error: unknown) => void;
  connect: () => void;
}
const documentKey = (id: string, path: string) => JSON.stringify([id, path]);

export default function ReaderWorkspace(props: WorkspaceProps) {
  const { manifest, libraryId, path, navigate } = props;
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const activeKey = libraryId && path ? documentKey(libraryId, path) : '';
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.deletedLibraryId)
      setDocuments((items) =>
        items.filter((item) => item.manifest.library.id !== props.deletedLibraryId),
      );
  }, [props.deletedLibraryId]);
  useEffect(() => {
    if (!manifest || manifest.library.id !== libraryId) return;
    setDocuments((previous) => {
      const next = previous.map((item) =>
        item.manifest.library.id === libraryId ? { ...item, manifest } : item,
      );
      if (
        path &&
        manifest.files.some((file) => file.path === path) &&
        !next.some((item) => item.key === activeKey)
      ) {
        next.push({ key: activeKey, path, manifest });
      }
      return next;
    });
  }, [manifest, libraryId, path, activeKey]);
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey, documents.length]);
  const select = (item: OpenDocument) =>
    navigate(item.manifest.library.kind, item.manifest.library.id, item.path);
  const close = (item: OpenDocument) => {
    const index = documents.indexOf(item);
    const remaining = documents.filter((entry) => entry !== item);
    setDocuments(remaining);
    if (item.key === activeKey) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) select(next);
      else navigate(item.manifest.library.kind);
    }
  };
  const current = documents.find((item) => item.key === activeKey);
  return (
    <div className="reader-workspace">
      {!!documents.length && (
        <div
          className="reader-tabs"
          data-single-file={documents.length === 1}
          ref={tabsRef}
          role="tablist"
          aria-label="已打开的文件"
        >
          {documents.map((item, index) => (
            <div
              className={`reader-tab ${item.key === activeKey ? 'selected' : ''}`}
              key={item.key}
            >
              <button
                type="button"
                role="tab"
                aria-selected={item.key === activeKey}
                tabIndex={item.key === activeKey ? 0 : -1}
                id={`reader-tab-${index}`}
                aria-controls={`reader-panel-${index}`}
                title={`${item.manifest.library.name} / ${item.path}`}
                onClick={() => select(item)}
                onKeyDown={(event) => {
                  let target = index;
                  if (event.key === 'ArrowRight') target = (index + 1) % documents.length;
                  else if (event.key === 'ArrowLeft')
                    target = (index + documents.length - 1) % documents.length;
                  else if (event.key === 'Home') target = 0;
                  else if (event.key === 'End') target = documents.length - 1;
                  else if (event.key === 'Delete') {
                    close(item);
                    return;
                  } else return;
                  event.preventDefault();
                  select(documents[target]);
                  tabsRef.current
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [target]?.focus();
                }}
              >
                {item.path.split('/').pop()}
              </button>
              <button
                type="button"
                className="reader-tab-close"
                aria-label={`关闭文件 ${item.path}`}
                onClick={() => close(item)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="reader-panels">
        {documents.map((item, index) => (
          <div
            key={item.key}
            className="reader-panel"
            role="tabpanel"
            id={`reader-panel-${index}`}
            aria-labelledby={`reader-tab-${index}`}
            hidden={item.key !== activeKey}
          >
            <ReaderPanel
              {...props}
              document={item}
              active={item.key === activeKey}
              line={item.key === activeKey ? props.line : undefined}
            />
          </div>
        ))}
        {!current && (
          <div className="reader-empty">
            {path && (!manifest || manifest.library.id !== libraryId) ? (
              <LoaderCircle className="spin" size={30} />
            ) : (
              <BookOpen size={35} />
            )}
            <p>
              {path
                ? manifest &&
                  manifest.library.id === libraryId &&
                  !manifest.files.some((file) => file.path === path)
                  ? '这份文件已移动或删除，请从目录重新选择'
                  : '正在打开文件…'
                : '选择文件开始阅读'}
            </p>
            {!path && manifest?.library.kind === 'notes' && !manifest.files.length && (
              <button className="button primary" disabled={props.offline} onClick={props.connect}>
                设置云端同步
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReaderPanel({
  document,
  active,
  ...props
}: WorkspaceProps & { document: OpenDocument; active: boolean }) {
  const { user, notify, handleError, onOutline } = props;
  const { manifest, path } = document;
  const file = manifest.files.find((entry) => entry.path === path);
  const [loaded, setLoaded] = useState<{ text: string; url: string; file: FileEntry }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const imageUrl = useRef('');
  useEffect(
    () => () => {
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    },
    [],
  );
  // Keep the source hash paired with the displayed content until its replacement arrives.
  const displayedManifest = useMemo(
    () =>
      !loaded || file?.hash === loaded.file.hash
        ? manifest
        : {
            ...manifest,
            files: manifest.files.map((entry) => (entry.path === path ? loaded.file : entry)),
          },
    [manifest, loaded, path, file?.hash],
  );
  const hash = file?.hash;
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    setError('');
    void (async () => {
      try {
        const blob = await fileBlob(user, manifest.library.id, file, true, controller.signal);
        const text = file.isText ? await blob.text() : '';
        if (controller.signal.aborted) return;
        const objectUrl = file.mediaType.startsWith('image/') ? URL.createObjectURL(blob) : '';
        const previousUrl = imageUrl.current;
        imageUrl.current = objectUrl;
        setLoaded({ text, url: objectUrl, file });
        if (previousUrl) URL.revokeObjectURL(previousUrl);
      } catch (cause: any) {
        if (controller.signal.aborted) return;
        setError(cause.message || '文件打开失败，请重试');
        if (cause instanceof HttpError && cause.status === 401) handleError(cause);
      }
    })();
    return () => {
      controller.abort();
    };
    // A tab retains its request, content and reader while another tab is active.
  }, [user.id, manifest.library.id, path, hash, attempt]);
  useEffect(() => {
    if (active && loaded) {
      try {
        localStorage.setItem(`codesip:reading:${user.id}:${manifest.library.id}`, path);
      } catch {
        /* Best effort. */
      }
    }
  }, [active, loaded, user.id, manifest.library.id, path]);
  const outline = useCallback(
    (items: OutlineItem[]) => {
      if (active) onOutline(items);
    },
    [active, onOutline],
  );
  const navigate = useCallback(
    (target: string, line?: number, heading?: string) => {
      props.navigate(manifest.library.kind, manifest.library.id, target, line, heading);
    },
    [props.navigate, manifest.library.id, manifest.library.kind],
  );
  return (
    <>
      {(!file || error) && (
        <div className="reader-file-error" role="alert">
          <CloudOff size={18} />
          <span>{file ? error : '文件已从项目移除；这里保留上次打开的内容'}</span>
          {file && (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              重试
            </button>
          )}
        </div>
      )}
      <Suspense
        fallback={
          <div className="reader-empty">
            <LoaderCircle className="spin" size={30} />
            <p>正在打开文件…</p>
          </div>
        }
      >
        {!loaded ? (
          !error && (
            <div className="reader-empty">
              <LoaderCircle className="spin" size={30} />
              <p>正在打开文件…</p>
            </div>
          )
        ) : /\.md(?:own)?$/i.test(path) && loaded.file.isText ? (
          <MarkdownReader
            active={active}
            theme={props.theme}
            setTheme={props.setTheme}
            line={props.line}
            heading={props.heading}
            jump={props.jump}
            onOutline={outline}
            text={loaded.text}
            path={path}
            user={user}
            manifest={displayedManifest}
            offline={props.offline}
            navigate={navigate}
            notify={notify}
          />
        ) : loaded.url ? (
          <div className="image-reader">
            <img src={loaded.url} alt={path} />
          </div>
        ) : loaded.file.isText ? (
          <CodeReader
            active={active}
            identity={{ userId: user.id, libraryId: manifest.library.id, path }}
            notify={notify}
            text={loaded.text}
            path={path}
            dark={props.theme === 'warm-slate'}
            wrap={props.wrap}
            line={props.line}
            jump={props.jump}
            onOutline={outline}
          />
        ) : (
          <div className="reader-empty">
            <File size={35} />
            <p>这个文件暂不支持预览</p>
          </div>
        )}
      </Suspense>
    </>
  );
}
