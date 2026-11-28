import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { oneDark } from '@codemirror/theme-one-dark';
import { MessageSquarePlus } from 'lucide-react';
import { AnnotationPanel, type AnnotationTarget } from './AnnotationPanel';
import './code-reader.css';
import {
  readerKey,
  trackReadingPosition,
  type OutlineItem,
  type ReaderIdentity,
} from './readerState';

// CodeMirror generates its token classes. Theme tokens must be registered with
// the highlighter, rather than selectors such as .cm-keyword that never match.
const paperHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--syn-keyword)' },
    { tag: [tags.string, tags.character, tags.regexp], color: 'var(--syn-string)' },
    { tag: [tags.number, tags.bool, tags.atom, tags.null], color: 'var(--syn-number)' },
    { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syn-type)' },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: 'var(--syn-func)',
    },
    { tag: [tags.comment, tags.meta], color: 'var(--text-secondary)', fontStyle: 'italic' },
    { tag: [tags.operator, tags.punctuation], color: 'var(--text-secondary)' },
    { tag: tags.invalid, color: 'var(--syn-keyword)', textDecoration: 'underline wavy' },
  ]),
);

// A source offset identifies the visible wrapped row even when its logical line is
// hundreds of screen rows tall. Pixel scrollTop (and a line-only snapshot) cannot.
interface CodeViewport {
  position: number;
  top: number;
  left: number;
}

function readCodeViewport(view: EditorView): CodeViewport | null {
  const scroller = view.scrollDOM;
  if (!scroller.clientWidth || !scroller.clientHeight) return null;
  const bounds = scroller.getBoundingClientRect();
  const gutterWidth = view.dom.querySelector('.cm-gutters')?.getBoundingClientRect().width || 0;
  const position = view.posAtCoords({
    x: bounds.left + gutterWidth + 9,
    y: bounds.top + Math.min(view.defaultLineHeight / 2, scroller.clientHeight / 2),
  });
  if (position === null) return null;
  const coordinates = view.coordsAtPos(position, 1);
  if (!coordinates) return null;
  return {
    position,
    top: coordinates.top - bounds.top,
    left: coordinates.left - bounds.left - gutterWidth,
  };
}

function viewportEffect(anchor: CodeViewport) {
  // A scroll effect never changes selection, focus, folds, or document contents.
  return EditorView.scrollIntoView(anchor.position, {
    y: 'start',
    yMargin: anchor.top,
    x: 'start',
    xMargin: anchor.left,
  });
}

function trackCodeViewport(view: EditorView, identity: ReaderIdentity, restore: boolean) {
  const key = readerKey('code-viewport', identity);
  let cleared = false;
  let anchor: CodeViewport | null = null;
  try {
    const saved = restore && JSON.parse(localStorage.getItem(key) || 'null');
    if (
      saved &&
      saved.length === view.state.doc.length &&
      Number.isInteger(saved.position) &&
      saved.position >= 0 &&
      saved.position <= view.state.doc.length &&
      Number.isFinite(saved.top) &&
      Number.isFinite(saved.left)
    )
      anchor = { position: saved.position, top: saved.top, left: saved.left };
  } catch {
    /* Older pixel progress remains a fallback when source progress is unavailable. */
  }
  const restored = !!anchor;
  let active = true;
  let configured = false;
  let frame = 0;
  let preserving = restored;
  let observedScroll: { top: number; left: number } | null = null;
  const hasScrolled = () =>
    !observedScroll ||
    observedScroll.top !== view.scrollDOM.scrollTop ||
    observedScroll.left !== view.scrollDOM.scrollLeft;
  let width = view.scrollDOM.clientWidth;
  let height = view.scrollDOM.clientHeight;
  const remember = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!active || !view.scrollDOM.clientHeight) return;
      if (resize()) return;
      // Keep the same character through consecutive zoom steps. Recapturing the
      // new wrapped row's first character on every step slowly drifts backwards.
      if (preserving && anchor) {
        // Very long wrapped lines can be taller than the viewport. CodeMirror's
        // first scroll uses estimated block heights; correct against the source
        // character after those blocks have actually been measured.
        const coordinates = view.coordsAtPos(anchor.position, 1);
        if (coordinates) {
          const scroller = view.scrollDOM;
          const bounds = scroller.getBoundingClientRect();
          const beforeTop = scroller.scrollTop;
          const beforeLeft = scroller.scrollLeft;
          const deltaY = coordinates.top - bounds.top - anchor.top;
          if (Math.abs(deltaY) > 1) scroller.scrollTop += deltaY;
          if (!view.lineWrapping) {
            const gutter =
              view.dom.querySelector('.cm-gutters')?.getBoundingClientRect().width || 0;
            const deltaX = coordinates.left - bounds.left - gutter - anchor.left;
            if (Math.abs(deltaX) > 1) scroller.scrollLeft += deltaX;
          }
          if (scroller.scrollTop !== beforeTop || scroller.scrollLeft !== beforeLeft) {
            remember();
            return;
          }
        }
      } else if (!anchor || hasScrolled()) {
        anchor = readCodeViewport(view) || anchor;
      }
      preserving = false;
      observedScroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    });
  };
  const resize = () => {
    const nextWidth = view.scrollDOM.clientWidth;
    const nextHeight = view.scrollDOM.clientHeight;
    if (!active || !nextWidth || !nextHeight) return false;
    if (width === nextWidth && height === nextHeight) return false;
    width = nextWidth;
    height = nextHeight;
    if (anchor) {
      preserving = true;
      view.dispatch({ effects: viewportEffect(anchor) });
    }
    remember();
    return true;
  };
  const persist = () => {
    if (cleared) return;
    // Hidden tabs have zero geometry. Keep their last visible source anchor.
    if (active && !preserving && hasScrolled()) anchor = readCodeViewport(view) || anchor;
    if (!anchor) return;
    try {
      localStorage.setItem(key, JSON.stringify({ ...anchor, length: view.state.doc.length }));
    } catch {
      /* Best-effort reading progress. */
    }
  };
  const interact = () => {
    // A user's scroll or selection takes precedence over pending layout correction.
    preserving = false;
    anchor = null;
    observedScroll = null;
  };
  const clear = () => {
    cleared = true;
    anchor = null;
  };
  const libraryRemoved = (event: Event) => {
    const detail = (event as CustomEvent<{ userId: string; libraryId: string }>).detail;
    if (detail?.userId === identity.userId && detail.libraryId === identity.libraryId) clear();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(view.scrollDOM);
  view.scrollDOM.addEventListener('scroll', remember, { passive: true });
  for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown'])
    view.scrollDOM.addEventListener(event, interact, { passive: true });
  window.addEventListener('pagehide', persist);
  window.addEventListener('codesip:private-data-cleared', clear);
  window.addEventListener('codesip:library-removed', libraryRemoved);
  document.addEventListener('visibilitychange', persist);
  if (anchor) view.dispatch({ effects: viewportEffect(anchor) });
  remember();
  return {
    remember,
    restored,
    configure(effects: StateEffect<unknown>[], nextActive: boolean) {
      // The new view already has this configuration. Source progress restores
      // above; older pixel progress remains the fallback on its first frame.
      if (!configured) {
        configured = true;
        active = nextActive;
        return;
      }
      if (!nextActive) {
        active = false;
        return;
      }
      // Hidden tabs keep their last visible source position. Reading their zero
      // dimensions, or applying typography while hidden, would discard progress.
      if (
        active &&
        !preserving &&
        (!anchor || hasScrolled()) &&
        width === view.scrollDOM.clientWidth &&
        height === view.scrollDOM.clientHeight
      )
        anchor = readCodeViewport(view) || anchor;
      active = true;
      width = view.scrollDOM.clientWidth;
      height = view.scrollDOM.clientHeight;
      preserving = !!anchor;
      view.dispatch({ effects: anchor ? [...effects, viewportEffect(anchor)] : effects });
      remember();
    },
    jump() {
      // Explicit navigation must take priority over a pending resize restoration.
      anchor = null;
      preserving = false;
      observedScroll = null;
      remember();
    },
    destroy() {
      persist();
      cancelAnimationFrame(frame);
      observer.disconnect();
      view.scrollDOM.removeEventListener('scroll', remember);
      for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown'])
        view.scrollDOM.removeEventListener(event, interact);
      window.removeEventListener('pagehide', persist);
      window.removeEventListener('codesip:private-data-cleared', clear);
      window.removeEventListener('codesip:library-removed', libraryRemoved);
      document.removeEventListener('visibilitychange', persist);
    },
  };
}

export default function CodeReader({
  active = true,
  text,
  path,
  identity,
  notify,
  dark = false,
  wrap = true,
  line,
  jump,
  onOutline,
}: {
  active?: boolean;
  text: string;
  path: string;
  identity: ReaderIdentity;
  notify: (message: string) => void;
  dark?: boolean;
  wrap?: boolean;
  line?: number;
  jump: number;
  onOutline: (items: OutlineItem[]) => void;
}) {
  const readSize = () => {
    try {
      return Math.min(
        24,
        Math.max(10, Number(localStorage.getItem('codesip:code-font-size')) || 14),
      );
    } catch {
      return 14;
    }
  };
  const [fontSize, setFontSize] = useState(readSize);
  const resize = (size: number) => {
    setFontSize(size);
    try {
      localStorage.setItem('codesip:code-font-size', String(size));
    } catch {
      /* Apply for this session. */
    }
  };
  useLayoutEffect(() => {
    if (active) setFontSize(readSize());
  }, [active]);
  const root = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const viewportRef = useRef<ReturnType<typeof trackCodeViewport> | null>(null);
  const compartments = useRef({
    wrap: new Compartment(),
    theme: new Compartment(),
    typography: new Compartment(),
  });
  const [activeLine, setActiveLine] = useState(line || 1);
  const [target, setTarget] = useState<AnnotationTarget | null>(null);
  const positionKey = readerKey('position', identity);
  const scrollToLine = (value: number) => {
    const view = viewRef.current;
    if (!view) return;
    const number = Math.max(1, Math.min(Math.floor(value), view.state.doc.lines));
    const from = view.state.doc.line(number).from;
    viewportRef.current?.jump();
    view.dispatch({
      selection: { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    setActiveLine(number);
  };
  useLayoutEffect(() => {
    if (!root.current) return;
    let alive = true;
    const view = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
          EditorState.tabSize.of(4),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': '代码内容', tabindex: '0' }),
          EditorView.domEventHandlers({
            click(event, editor) {
              const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos !== null) setActiveLine(editor.state.doc.lineAt(pos).number);
            },
          }),
          EditorView.theme({
            '&': {
              height: '100%',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-primary)',
            },
            '.cm-scroller': {
              fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
              lineHeight: '1.65',
              overflow: 'auto',
            },
            '.cm-content': { padding: '12px 0 40px' },
            '.cm-gutters': {
              backgroundColor: 'var(--bg-surface-muted)',
              borderRight: '1px solid var(--border-hairline)',
              color: 'var(--text-secondary)',
              userSelect: 'none',
            },
            '.cm-activeLineGutter, .cm-activeLine': { backgroundColor: 'var(--accent-soft)' },
            '.cm-line': { padding: '0 12px 0 8px' },
          }),
          compartments.current.typography.of(
            EditorView.theme({ '&': { fontSize: `${fontSize}px` } }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.geometryChanged || update.viewportChanged) viewportRef.current?.remember();
            if (update.selectionSet)
              setActiveLine(update.state.doc.lineAt(update.state.selection.main.head).number);
          }),
          compartments.current.theme.of(dark ? oneDark : paperHighlight),
          compartments.current.wrap.of(wrap ? EditorView.lineWrapping : []),
        ],
      }),
    });
    viewRef.current = view;
    const viewport = trackCodeViewport(view, identity, line === undefined);
    viewportRef.current = viewport;
    const language = languages.find((item) =>
      item.extensions.includes(path.split('.').pop()?.toLowerCase() || ''),
    );
    language
      ?.load()
      .then((extension) => {
        if (alive) view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
      })
      .catch(() => {});
    const stopTracking = trackReadingPosition(
      view.scrollDOM,
      positionKey,
      line === undefined && !viewport.restored,
    );
    return () => {
      alive = false;
      viewport.destroy();
      viewportRef.current = null;
      stopTracking();
      view.destroy();
      viewRef.current = null;
    };
  }, [text, path, positionKey]);
  useLayoutEffect(() => {
    viewportRef.current?.configure(
      [
        compartments.current.typography.reconfigure(
          EditorView.theme({ '&': { fontSize: `${fontSize}px` } }),
        ),
        compartments.current.theme.reconfigure(dark ? oneDark : paperHighlight),
        compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
      ],
      active,
    );
  }, [active, dark, wrap, fontSize, text, path, positionKey]);
  const lastJump = useRef<{ line: number; jump: number; text: string } | null>(null);
  useEffect(() => {
    if (!active || line === undefined) return;
    if (
      lastJump.current?.line === line &&
      lastJump.current.jump === jump &&
      lastJump.current.text === text
    )
      return;
    scrollToLine(line);
    lastJump.current = { line, jump, text };
  }, [active, line, jump, text]);
  useEffect(() => {
    const items: OutlineItem[] = [];
    text.split('\n').forEach((value, index) => {
      const match = value.match(
        /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def|struct|fn|func)\s+([\w$]+)|^\s*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=.*=>/,
      );
      if (match) items.push({ name: match[1] || match[2], line: index + 1 });
    });
    onOutline(items.slice(0, 150));
  }, [text, onOutline]);
  return (
    <div className="code-reader-container">
      <div className="code-reader-toolbar">
        <div className="code-reader-status">L{activeLine}</div>
        <div className="code-zoom" role="group" aria-label="代码字号">
          <button
            type="button"
            aria-label="缩小代码"
            disabled={fontSize <= 10}
            onClick={() => resize(fontSize - 1)}
          >
            A−
          </button>
          <button
            type="button"
            aria-label="重置代码字号"
            title="恢复默认字号"
            onClick={() => resize(14)}
          >
            {Math.round((fontSize / 14) * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大代码"
            disabled={fontSize >= 24}
            onClick={() => resize(fontSize + 1)}
          >
            A+
          </button>
        </div>
        <button
          type="button"
          className="code-annotate-btn"
          onClick={() =>
            setTarget({ line: activeLine, snippet: text.split('\n')[activeLine - 1]?.trim() || '' })
          }
        >
          <MessageSquarePlus size={14} />
          <span>添加标注</span>
        </button>
      </div>
      <div className="code-reader" ref={root} />
      <AnnotationPanel
        identity={identity}
        notify={notify}
        code
        target={active ? target : null}
        setTarget={(next) => {
          if (next) scrollToLine(next.line);
          setTarget(next);
        }}
      />
    </div>
  );
}
