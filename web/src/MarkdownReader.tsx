import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Code } from 'lucide-react';
import type { Manifest, User } from '../../shared/types';
import { fileBlob } from './api';
import { CodeBlockView } from './CodeBlockView';
import './reader-theme.css';
function getNodeText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join('');
  if (typeof node === 'object' && node.props && node.props.children) {
    return getNodeText(node.props.children);
  }
  return '';
}

function wikiLinks() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (!node.children || ['code', 'inlineCode', 'link', 'image'].includes(node.type)) return;
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== 'text') {
          visit(child);
          return [child];
        }
        const pieces: any[] = [];
        const rx = /(!?)\[\[([^\]]+)\]\]/g;
        let start = 0;
        let match;
        while ((match = rx.exec(child.value))) {
          if (match.index > start)
            pieces.push({ type: 'text', value: child.value.slice(start, match.index) });
          const [target, label] = match[2].split('|');
          pieces.push(
            match[1]
              ? { type: 'image', url: encodeURI(target), alt: label || target }
              : {
                  type: 'link',
                  url: encodeURI(target),
                  children: [{ type: 'text', value: label || target }],
                },
          );
          start = rx.lastIndex;
        }
        if (start < child.value.length)
          pieces.push({ type: 'text', value: child.value.slice(start) });
        return pieces.length ? pieces : [child];
      });
    };
    visit(tree);
  };
}
export function resolveFile(source: string, target: string, paths: string[]): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split('#')[0].split('?')[0]);
  } catch {
    return;
  }
  if (!decoded) return source;
  const normalize = (p: string) => {
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  };
  const parent = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : '';
  const candidates = [normalize(parent + decoded), normalize(decoded)];
  for (const c of candidates)
    for (const value of [c, c + '.md']) if (paths.includes(value)) return value;
  const matches = paths.filter(
    (p) => p.split('/').pop() === decoded || p.split('/').pop() === decoded + '.md',
  );
  return matches.length === 1 ? matches[0] : undefined;
}
function VaultImage({
  src,
  alt,
  user,
  manifest,
  path,
  offline,
}: {
  src?: string;
  alt?: string;
  user: User;
  manifest: Manifest;
  path: string;
  offline: boolean;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    setUrl('');
    setError('');
    if (!src) return;
    if (/^https?:\/\//.test(src)) {
      setError('外部图片未缓存，可在原笔记中查看');
      return;
    }
    const resolved = resolveFile(
      path,
      src,
      manifest.files.map((f) => f.path),
    );
    const file = manifest.files.find((f) => f.path === resolved);
    if (!file || !file.mediaType.startsWith('image/')) {
      setError('图片未同步');
      return;
    }
    fileBlob(user, manifest.library.id, file, !offline)
      .then((blob) => {
        if (alive) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, path, manifest, offline]);
  return url ? (
    <img src={url} alt={alt || ''} loading="lazy" />
  ) : (
    <span className="image-fallback">
      {error || '加载图片…'}
      {alt ? ` · ${alt}` : ''}
    </span>
  );
}
export default function MarkdownReader({
  text,
  path,
  user,
  manifest,
  offline,
  navigate,
  notify,
}: {
  text: string;
  path: string;
  user: User;
  manifest: Manifest;
  offline: boolean;
  navigate: (path: string) => void;
  notify: (message: string) => void;
}) {
  const [theme, setThemeState] = useState<'paper-light' | 'warm-slate' | 'sepia-parchment'>(
    () => (localStorage.getItem('codesip:reader-theme') as any) || 'paper-light',
  );
  const setTheme = (nextTheme: 'paper-light' | 'warm-slate' | 'sepia-parchment') => {
    setThemeState(nextTheme);
    try {
      localStorage.setItem('codesip:reader-theme', nextTheme);
      document.documentElement.setAttribute('data-theme', nextTheme);
    } catch {}
  };
  const [codeOnly, setCodeOnly] = useState(false);
  const [bottomSheetOpen, setBottomSheetOpen] = useState(false);
  const [annotationNote, setAnnotationNote] = useState('');

  const handleSaveAnnotation = () => {
    if (!annotationNote.trim()) return;
    notify(`批注已保存为标准 Markdown 引用：> [!NOTE] ${annotationNote.trim()}`);
    setAnnotationNote('');
    setBottomSheetOpen(false);
  };

  return (
    <article
      className={`markdown theme-${theme} ${codeOnly ? 'code-only-mode' : ''}`}
      contentEditable={false}
    >
      <div className="reader-controls-bar">
        <div className="reader-theme-selector">
          <button
            type="button"
            className={`theme-pill-btn ${theme === 'paper-light' ? 'active' : ''}`}
            onClick={() => setTheme('paper-light')}
          >
            素笺暖白
          </button>
          <button
            type="button"
            className={`theme-pill-btn ${theme === 'warm-slate' ? 'active' : ''}`}
            onClick={() => setTheme('warm-slate')}
          >
            松烟暖灰
          </button>
          <button
            type="button"
            className={`theme-pill-btn ${theme === 'sepia-parchment' ? 'active' : ''}`}
            onClick={() => setTheme('sepia-parchment')}
          >
            羊皮纸棕
          </button>
        </div>

        <button
          type="button"
          className={`code-filter-toggle-btn ${codeOnly ? 'active' : ''}`}
          onClick={() => setCodeOnly(!codeOnly)}
          title="仅看知识点标题与核心代码块"
        >
          <Code size={14} />
          <span>仅看代码</span>
        </button>
      </div>

      <ReactMarkdown
        remarkPlugins={[remarkGfm, wikiLinks]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                if (/^https?:\/\/|^mailto:/.test(href || '')) return;
                event.preventDefault();
                const target = resolveFile(
                  path,
                  href || '',
                  manifest.files.map((f) => f.path),
                );
                if (target) {
                  navigate(target);
                  if (href?.includes('#')) notify('已打开目标笔记；标题和块定位将在后续版本支持');
                } else notify('未找到链接目标，请确认该笔记已同步且名称唯一');
              }}
              target={/^https?:\/\//.test(href || '') ? '_blank' : undefined}
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <VaultImage
              src={typeof src === 'string' ? src : undefined}
              alt={alt}
              user={user}
              manifest={manifest}
              path={path}
              offline={offline}
            />
          ),
          table: ({ children }) => (
            <div className="md-table-wrapper reader-table-scroll-container">
              <table className="reader-markdown-table">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="reader-table-th">{children}</th>,
          td: ({ children }) => <td className="reader-table-td">{children}</td>,
          code: ({ children, className }) => {
            const match = /language-(\w+)/.exec(className || '');
            const rawCode = getNodeText(children).replace(/\n$/, '');
            if (match || rawCode.includes('\n')) {
              return (
                <CodeBlockView
                  language={match ? match[1] : 'text'}
                  code={rawCode}
                  childrenContent={children}
                />
              );
            }
            return <code className={className}>{children}</code>;
          },
          p: ({ children }) => (
            <p
              onContextMenu={(e) => {
                e.preventDefault();
                setBottomSheetOpen(true);
              }}
            >
              {children}
            </p>
          ),
        }}
      >
        {text}
      </ReactMarkdown>

      {bottomSheetOpen && (
        <>
          <div
            className="bottom-sheet-backdrop"
            onClick={() => setBottomSheetOpen(false)}
          />
          <div className="bottom-sheet-drawer">
            <div className="bottom-sheet-handle" />
            <div className="bottom-sheet-header">
              <span>添加轻量划线批注 (Quick Note)</span>
              <button
                type="button"
                className="bottom-sheet-close"
                onClick={() => setBottomSheetOpen(false)}
              >
                关闭
              </button>
            </div>
            <textarea
              className="bottom-sheet-input"
              rows={3}
              autoFocus
              placeholder="输入你的批注或思考，保存后将以标准 Markdown 引用写入..."
              value={annotationNote}
              onChange={(e) => setAnnotationNote(e.target.value)}
            />
            <div className="bottom-sheet-actions">
              <button
                type="button"
                className="bottom-sheet-save-btn"
                onClick={handleSaveAnnotation}
              >
                保存为引用批注
              </button>
            </div>
          </div>
        </>
      )}
    </article>
  );
}
