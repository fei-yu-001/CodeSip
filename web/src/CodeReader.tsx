import { useEffect, useRef, useState } from 'react';
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
              fontSize: '13.5px',
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
    if (line !== undefined) scrollToLine(line);
  }, [line, jump, text]);
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
        <div className="code-reader-status">当前行：L{activeLine}</div>
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
        target={target}
        setTarget={(next) => {
          if (next) scrollToLine(next.line);
          setTarget(next);
        }}
      />
    </div>
  );
}
