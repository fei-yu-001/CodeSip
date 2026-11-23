import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Code, MessageSquarePlus } from 'lucide-react';
import { AnnotationPanel, type AnnotationTarget } from './AnnotationPanel';
import { readerKey, trackReadingPosition, type ReaderTheme, type OutlineItem } from './readerState';
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

function readerPositions() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (
        node.type === 'element' &&
        /^(h[1-6]|p|pre|blockquote|table|li)$/.test(node.tagName) &&
        node.position
      ) {
        node.properties = { ...node.properties, 'data-source-line': node.position.start.line };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
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
  theme,
  setTheme,
  line,
  jump,
  onOutline,
}: {
  text: string;
  path: string;
  user: User;
  manifest: Manifest;
  offline: boolean;
  navigate: (path: string) => void;
  notify: (message: string) => void;
  theme: ReaderTheme;
  setTheme: (theme: ReaderTheme) => void;
  line?: number;
  jump: number;
  onOutline: (items: OutlineItem[]) => void;
}) {
  const [codeOnly, setCodeOnly] = useState(false);
  const [target, setTarget] = useState<AnnotationTarget | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const identity = { userId: user.id, libraryId: manifest.library.id, path };
  const positionKey = readerKey('position', identity);
  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    onOutline(
      Array.from(
        article.querySelectorAll<HTMLElement>('.markdown-content :is(h1,h2,h3,h4,h5,h6)'),
      ).map((heading) => ({
        name: heading.textContent || '',
        line: Number(heading.dataset.sourceLine),
        level: Number(heading.tagName.slice(1)),
      })),
    );
    return trackReadingPosition(article, positionKey, line === undefined);
  }, [text, positionKey, onOutline]);
  useEffect(() => {
    const article = articleRef.current;
    if (!article || line === undefined) return;
    setCodeOnly(false);
    const frame = requestAnimationFrame(() => {
      const blocks = Array.from(article.querySelectorAll<HTMLElement>('[data-source-line]'));
      const block =
        blocks.filter((element) => Number(element.dataset.sourceLine) <= line).at(-1) || blocks[0];
      if (block)
        article.scrollTop +=
          block.getBoundingClientRect().top - article.getBoundingClientRect().top - 16;
    });
    return () => cancelAnimationFrame(frame);
  }, [line, jump, text]);

  return (
    <article
      ref={articleRef}
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
          className="code-filter-toggle-btn"
          aria-label="添加笔记批注"
          onClick={() => setTarget({ line: 1, snippet: path })}
        >
          <MessageSquarePlus size={14} />
          <span>批注</span>
        </button>
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

      <div className="markdown-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, wikiLinks]}
          rehypePlugins={[
            [rehypeHighlight, { detect: false, ignoreMissing: true }],
            readerPositions,
          ]}
          components={{
            pre: ({ children, node }) => (
              <div className="code-block-source" data-source-line={node?.position?.start.line}>
                {children}
              </div>
            ),
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
                    if (href?.includes('#')) notify('已打开目标笔记，可通过目录定位章节');
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
            table: ({ children, node }) => (
              <div
                className="md-table-wrapper reader-table-scroll-container"
                data-source-line={node?.position?.start.line}
              >
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
            p: ({ children, node }) => (
              <p
                data-source-line={node?.position?.start.line}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTarget({
                    line: node?.position?.start.line || 1,
                    snippet:
                      window.getSelection()?.toString().trim() || e.currentTarget.textContent || '',
                  });
                }}
              >
                {children}
              </p>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
      <AnnotationPanel identity={identity} target={target} setTarget={setTarget} notify={notify} />
    </article>
  );
}
