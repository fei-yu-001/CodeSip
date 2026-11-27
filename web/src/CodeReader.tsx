import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorView } from '@codemirror/view';
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { MessageSquarePlus } from 'lucide-react';
import { AnnotationPanel, type AnnotationTarget } from './AnnotationPanel';
import {
  readerKey,
  trackReadingPosition,
  type OutlineItem,
  type ReaderIdentity,
} from './readerState';

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
  useEffect(() => {
    if (active) setFontSize(readSize());
  }, [active]);
  const root = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartments = useRef({ wrap: new Compartment(), theme: new Compartment() });
  const [activeLine, setActiveLine] = useState(line || 1);
  const [target, setTarget] = useState<AnnotationTarget | null>(null);
  const positionKey = readerKey('position', identity);
  const scrollToLine = (value: number) => {
    const view = viewRef.current;
    if (!view) return;
    const number = Math.max(1, Math.min(Math.floor(value), view.state.doc.lines));
    const from = view.state.doc.line(number).from;
    view.dispatch({
      selection: { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    setActiveLine(number);
  };
  useEffect(() => {
    if (!root.current) return;
    let alive = true;
    const view = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
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
              fontSize: 'var(--code-font-size)',
              height: '100%',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-primary)',
            },
            '.cm-scroller': {
              fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
              lineHeight: '1.75',
              overflow: 'auto',
            },
            '.cm-content': { padding: '16px 0 60px' },
            '.cm-gutters': {
              backgroundColor: 'var(--bg-surface-muted)',
              borderRight: '1px solid var(--border-hairline)',
              color: 'var(--text-secondary)',
              userSelect: 'none',
            },
            '.cm-activeLineGutter, .cm-activeLine': { backgroundColor: 'var(--accent-soft)' },
            '.cm-line': { padding: '0 16px 0 10px' },
          }),
          compartments.current.theme.of(dark ? oneDark : []),
          compartments.current.wrap.of(wrap ? EditorView.lineWrapping : []),
        ],
      }),
    });
    viewRef.current = view;
    const language = languages.find((item) =>
      item.extensions.includes(path.split('.').pop()?.toLowerCase() || ''),
    );
    language
      ?.load()
      .then((extension) => {
        if (alive) view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
      })
      .catch(() => {});
    const stopTracking = trackReadingPosition(view.scrollDOM, positionKey, line === undefined);
    return () => {
      alive = false;
      stopTracking();
      view.destroy();
      viewRef.current = null;
    };
  }, [text, path, positionKey]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        compartments.current.theme.reconfigure(dark ? oneDark : []),
        compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
      ],
    });
  }, [dark, wrap, text]);
  useEffect(() => {
    if (active) viewRef.current?.requestMeasure();
  }, [active, fontSize]);
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
    <div
      className="code-reader-container"
      style={{ '--code-font-size': `${fontSize}px` } as CSSProperties}
    >
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
