import 'katex/dist/katex.min.css';
import './markdown/formatting.css';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Components } from 'hast-util-to-jsx-runtime';
import { MarkdownChunkView } from './markdown/MarkdownChunkView';
import { useMarkdownDocument } from './markdown/useMarkdownDocument';
import { VaultImage } from './VaultImage';
import { Code, MessageSquarePlus, List, Pencil, SlidersHorizontal } from 'lucide-react';
import { AnnotationPanel, type AnnotationTarget } from './AnnotationPanel';
import { readerKey, trackReadingPosition, type ReaderTheme, type OutlineItem } from './readerState';
import type { Manifest, User } from '../../shared/types';
import { CodeBlockView } from './CodeBlockView';
import Modal from './Modal';
import { useDismissibleLayer } from './readerNavigation';
import { useDocumentCopy } from './documentCopies';
import { DocumentEditor } from './DocumentEditor';
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
export default function MarkdownReader({
  active = true,
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
  heading,
  jump,
  onOutline,
}: {
  active?: boolean;
  text: string;
  path: string;
  user: User;
  manifest: Manifest;
  offline: boolean;
  navigate: (path: string, line?: number, heading?: string) => void;
  notify: (message: string) => void;
  theme: ReaderTheme;
  setTheme: (theme: ReaderTheme) => void;
  line?: number;
  heading?: string;
  jump: number;
  onOutline: (items: OutlineItem[]) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [original, setOriginal] = useState(false);
  const [fontSize, setFontSize] = useState(() => {
    try {
      return Math.min(22, Math.max(14, Number(localStorage.getItem('codesip:font-size')) || 17));
    } catch {
      return 17;
    }
  });
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem('codesip:reading-width') === 'wide';
    } catch {
      return false;
    }
  });
  const [spacing, setSpacing] = useState(() => {
    try {
      return localStorage.getItem('codesip:line-spacing') === 'compact' ? 'compact' : 'relaxed';
    } catch {
      return 'relaxed';
    }
  });
  useDismissibleLayer(settingsOpen, () => setSettingsOpen(false));
  const [codeOnly, setCodeOnly] = useState(false);
  const [target, setTarget] = useState<AnnotationTarget | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const identity = { userId: user.id, libraryId: manifest.library.id, path };
  const canEdit = manifest.library.kind === 'notes';
  const sourceHash = manifest.files.find((file) => file.path === path)?.hash || '';
  const documentCopy = useDocumentCopy(identity, text, sourceHash, canEdit);
  // Keep the hidden reading surface stable while typing in the editor.
  const readingText = useRef(documentCopy.content);
  if (!editorOpen) readingText.current = documentCopy.content;
  const displayText = original ? text : readingText.current;
  const parsed = useMarkdownDocument(displayText);
  const positionKey = readerKey('position', identity);
  const selectionRef = useRef<AnnotationTarget | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    const selection = () => {
      const selected = window.getSelection();
      const node = selected?.anchorNode;
      if (!node || !articleRef.current?.contains(node)) return;
      const snippet = selected?.toString().trim();
      if (!snippet) return;
      const element = node instanceof Element ? node : node.parentElement;
      selectionRef.current = {
        line: Number(element?.closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine) || 1,
        snippet: snippet.slice(0, 2000),
      };
      setHasSelection(true);
    };
    document.addEventListener('selectionchange', selection);
    return () => document.removeEventListener('selectionchange', selection);
  }, []);
  const annotate = () => {
    const article = articleRef.current;
    const top = article?.getBoundingClientRect().top || 0;
    const block = Array.from(
      article?.querySelectorAll<HTMLElement>('.markdown-content [data-source-line]') || [],
    ).find(
      (element) =>
        element.getBoundingClientRect().bottom > top + 8 &&
        element.getBoundingClientRect().height > 0,
    );
    setTarget(
      selectionRef.current || {
        line: Number(block?.dataset.sourceLine) || 1,
        snippet: (block?.textContent || path).slice(0, 2000),
      },
    );
    selectionRef.current = null;
    setHasSelection(false);
  };
  const preference = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      notify('阅读设置已应用，本机暂时无法记住设置');
    }
  };
  useEffect(() => {
    onOutline(parsed.outline);
  }, [parsed.outline, onOutline]);
  useEffect(() => {
    const article = articleRef.current;
    if (article) return trackReadingPosition(article, positionKey, line === undefined);
  }, [displayText, positionKey, line === undefined]);
  const headingLine = heading
    ? parsed.outline.find(
        (item) => item.name.trim().toLocaleLowerCase() === heading.trim().toLocaleLowerCase(),
      )?.line
    : undefined;
  const targetLine = line ?? headingLine;
  const lastJump = useRef<{ text: string; line: number; jump: number } | null>(null);
  useEffect(() => {
    const article = articleRef.current;
    if (!active || !article || targetLine === undefined || !parsed.chunks.length) return;
    if (
      lastJump.current?.text === displayText &&
      lastJump.current.line === targetLine &&
      lastJump.current.jump === jump
    )
      return;
    // A search or outline click can arrive before its block has streamed in.
    if (!parsed.done && parsed.chunks.at(-1)!.endLine < targetLine) return;
    setCodeOnly(false);
    const frame = requestAnimationFrame(() => {
      const blocks = Array.from(article.querySelectorAll<HTMLElement>('[data-source-line]'));
      const block =
        blocks.filter((element) => Number(element.dataset.sourceLine) <= targetLine).at(-1) ||
        blocks[0];
      if (block) {
        // Outline/search targets may be inside nested collapsed sections.
        for (
          let parent = block.parentElement;
          parent && parent !== article;
          parent = parent.parentElement
        ) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        }
        article.scrollTop +=
          block.getBoundingClientRect().top - article.getBoundingClientRect().top - 16;
        lastJump.current = { text: displayText, line: targetLine, jump };
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, targetLine, jump, displayText, parsed.chunks.length, parsed.done]);

  // Selection and toolbar state must not recreate the selected DOM nodes.
  const components = useMemo<Partial<Components>>(
    () => ({
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
              let heading: string | undefined;
              try {
                heading = href?.includes('#')
                  ? decodeURIComponent(href.slice(href.indexOf('#') + 1))
                  : undefined;
              } catch {
                /* Open the file even if the fragment is malformed. */
              }
              navigate(target, undefined, heading);
            } else notify('未找到链接目标，请确认该笔记已同步且名称唯一');
          }}
          target={/^https?:\/\//.test(href || '') ? '_blank' : undefined}
          rel="noopener noreferrer"
        >
          {children}
        </a>
      ),
      img: ({ src, alt, width, height }) => (
        <VaultImage
          src={typeof src === 'string' ? src : undefined}
          alt={alt}
          width={width ? Number(width) : undefined}
          height={height ? Number(height) : undefined}
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
      p: ({ children, node }) => <p data-source-line={node?.position?.start.line}>{children}</p>,
    }),
    [path, user, manifest, offline, navigate, notify],
  );

  return (
    <div className="markdown-reader">
      {(documentCopy.copy || documentCopy.draft) && (
        <div className="reading-copy-status">
          <span>
            {original ? '电脑原文' : documentCopy.draft ? '我的编辑版 · 本机草稿' : '我的编辑版'}
            {(documentCopy.draft?.baseHash || documentCopy.copy?.baseHash) !== sourceHash &&
              ' · 原文有更新'}
          </span>
          <button type="button" onClick={() => setOriginal(!original)}>
            {original ? '查看我的编辑版' : '查看原文'}
          </button>
        </div>
      )}
      <article
        ref={articleRef}
        className={`markdown theme-${theme} ${codeOnly ? 'code-only-mode' : ''} ${wide ? 'reading-wide' : ''}`}
        style={
          {
            '--reader-font-size': `${fontSize}px`,
            '--reader-line-height': spacing === 'relaxed' ? '1.95' : '1.65',
          } as CSSProperties
        }
        onPointerDown={() => {
          selectionRef.current = null;
          setHasSelection(false);
        }}
        contentEditable={false}
      >
        <div
          className="markdown-content"
          data-render-complete={parsed.done}
          hidden={!parsed.chunks.length && !parsed.done}
        >
          {parsed.chunks.map((chunk, index) => (
            <MarkdownChunkView key={index} chunk={chunk} components={components} />
          ))}
        </div>
        {parsed.error ? (
          <p role="alert">
            正文排版失败。
            <button type="button" onClick={parsed.retry}>
              重试
            </button>
          </p>
        ) : (
          !parsed.done && (
            <p className="markdown-loading" role="status">
              {parsed.chunks.length ? '正在加载后续内容…' : '正在排版…'}
            </p>
          )
        )}
        <AnnotationPanel
          identity={identity}
          target={active ? target : null}
          setTarget={setTarget}
          notify={notify}
          listOpen={active && listOpen}
          closeList={() => setListOpen(false)}
        />
      </article>
      <nav className="reading-actions" aria-label="阅读操作">
        <button
          type="button"
          aria-label="添加笔记批注"
          disabled={!parsed.chunks.length}
          onPointerDown={(e) => e.preventDefault()}
          onClick={annotate}
        >
          <MessageSquarePlus size={19} />
          <span>{hasSelection ? '选段批注' : '批注'}</span>
        </button>
        <button type="button" aria-label="查看批注列表" onClick={() => setListOpen(true)}>
          <List size={19} />
          <span>批注列表</span>
        </button>
        {canEdit && (
          <button
            type="button"
            aria-label="编辑文档"
            disabled={!documentCopy.loaded}
            onClick={() => {
              setOriginal(false);
              setEditorOpen(true);
            }}
          >
            <Pencil size={19} />
            <span>{documentCopy.draft ? '继续编辑' : '编辑'}</span>
          </button>
        )}
        <button type="button" aria-label="阅读设置" onClick={() => setSettingsOpen(true)}>
          <SlidersHorizontal size={19} />
          <span>阅读设置</span>
        </button>
      </nav>
      {active &&
        settingsOpen &&
        createPortal(
          <Modal
            title="阅读设置"
            close={() => setSettingsOpen(false)}
            scrimClassName="reader-sheet-scrim"
          >
            <div className="reader-settings">
              <p className="reader-setting-label">纸张与配色</p>
              <div className="reader-theme-options">
                {(
                  [
                    ['paper-light', '素笺暖白'],
                    ['warm-slate', '松烟暖灰'],
                    ['sepia-parchment', '羊皮纸棕'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`reader-theme-option sample-${value}`}
                    aria-pressed={theme === value}
                    onClick={() => setTheme(value)}
                  >
                    <span>文</span>
                    {label}
                  </button>
                ))}
              </div>
              <div className="reader-setting-row">
                <span>正文字号</span>
                <div className="reader-stepper">
                  <button
                    type="button"
                    aria-label="减小字号"
                    disabled={fontSize <= 14}
                    onClick={() => {
                      setFontSize(fontSize - 1);
                      preference('codesip:font-size', String(fontSize - 1));
                    }}
                  >
                    A−
                  </button>
                  <output aria-label="当前字号">{fontSize}</output>
                  <button
                    type="button"
                    aria-label="增大字号"
                    disabled={fontSize >= 22}
                    onClick={() => {
                      setFontSize(fontSize + 1);
                      preference('codesip:font-size', String(fontSize + 1));
                    }}
                  >
                    A+
                  </button>
                </div>
              </div>
              <div className="reader-setting-row">
                <span>阅读宽度</span>
                <div className="reader-segment">
                  <button
                    type="button"
                    aria-pressed={!wide}
                    onClick={() => {
                      setWide(false);
                      preference('codesip:reading-width', 'comfortable');
                    }}
                  >
                    舒适
                  </button>
                  <button
                    type="button"
                    aria-pressed={wide}
                    onClick={() => {
                      setWide(true);
                      preference('codesip:reading-width', 'wide');
                    }}
                  >
                    铺满
                  </button>
                </div>
              </div>
              <div className="reader-setting-row">
                <span>段落行距</span>
                <div className="reader-segment">
                  {[
                    ['compact', '紧凑'],
                    ['relaxed', '舒展'],
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={spacing === value}
                      onClick={() => {
                        setSpacing(value);
                        preference('codesip:line-spacing', value);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="reader-code-filter"
                aria-pressed={codeOnly}
                onClick={() => {
                  setCodeOnly(!codeOnly);
                  setSettingsOpen(false);
                }}
              >
                <Code size={18} />
                <span>仅看代码</span>
                <span>{codeOnly ? '已开启' : '已关闭'}</span>
              </button>
            </div>
          </Modal>,
          document.body,
        )}
      <DocumentEditor
        open={active && editorOpen}
        close={() => setEditorOpen(false)}
        document={documentCopy}
        path={path}
        notify={notify}
      />
    </div>
  );
}
