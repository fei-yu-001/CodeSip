import { useEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState, StateEffect } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { MessageSquarePlus, Trash2, X, BookmarkCheck } from 'lucide-react';

const append = StateEffect.appendConfig;

interface Annotation {
  id: string;
  line: number;
  snippet: string;
  note: string;
  createdAt: number;
}

export default function CodeReader({
  text,
  path,
  dark = false,
  wrap = true,
  line = 1,
  onOutline,
}: {
  text: string;
  path: string;
  dark?: boolean;
  wrap?: boolean;
  line?: number;
  onOutline?: (items: { name: string; line: number }[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const [annotations, setAnnotations] = useState<Annotation[]>(() => {
    try {
      const saved = localStorage.getItem(`codesip:annotations:${path}`);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [activeLine, setActiveLine] = useState<number>(line || 1);
  const [activeSnippet, setActiveSnippet] = useState<string>('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetInput, setSheetInput] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const saveAnnotations = (nextList: Annotation[]) => {
    setAnnotations(nextList);
    try {
      localStorage.setItem(`codesip:annotations:${path}`, JSON.stringify(nextList));
    } catch {}
  };

  const handleOpenAnnotation = (targetLine: number) => {
    const lines = text.split('\n');
    const safeLine = Math.max(1, Math.min(targetLine, lines.length));
    const snippet = lines[safeLine - 1] || '';
    setActiveLine(safeLine);
    setActiveSnippet(snippet.trim());

    const existing = annotations.find((a) => a.line === safeLine);
    if (existing) {
      setEditingId(existing.id);
      setSheetInput(existing.note);
    } else {
      setEditingId(null);
      setSheetInput('');
    }
    setSheetOpen(true);
  };

  const handleSaveNote = () => {
    if (!sheetInput.trim()) return;
    let next: Annotation[];
    if (editingId) {
      next = annotations.map((a) =>
        a.id === editingId ? { ...a, note: sheetInput.trim(), createdAt: Date.now() } : a,
      );
    } else {
      const item: Annotation = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        line: activeLine,
        snippet: activeSnippet,
        note: sheetInput.trim(),
        createdAt: Date.now(),
      };
      next = [...annotations.filter((a) => a.line !== activeLine), item].sort(
        (a, b) => a.line - b.line,
      );
    }
    saveAnnotations(next);
    setSheetOpen(false);
    setSheetInput('');
  };

  const handleDeleteNote = (id: string) => {
    saveAnnotations(annotations.filter((a) => a.id !== id));
    if (editingId === id) {
      setSheetOpen(false);
      setSheetInput('');
    }
  };

  const scrollToLine = (targetLine: number) => {
    const view = viewRef.current;
    if (!view) return;
    const docLines = view.state.doc.lines;
    const clamped = Math.max(1, Math.min(targetLine, docLines));
    const lineObj = view.state.doc.line(clamped);
    view.dispatch({
      effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
    });
  };

  useEffect(() => {
    if (!root.current) return;
    let alive = true;

    const clickHandler = EditorView.domEventHandlers({
      click(event, view) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos !== null) {
          const clickedLine = view.state.doc.lineAt(pos).number;
          setActiveLine(clickedLine);
        }
      },
    });

    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    const shouldWrap = wrap || isMobile;

    const view = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': '代码内容', tabindex: '0' }),
          clickHandler,
          EditorView.theme({
            '&': { fontSize: '13.5px', height: '100%' },
            '.cm-scroller': {
              fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
              lineHeight: '1.75',
              overflow: 'auto',
            },
            '.cm-content': { padding: '16px 0 60px' },
            '.cm-gutters': {
              backgroundColor: dark ? '#1e2422' : '#f7f6f2',
              borderRight: dark ? '1px solid #2a3330' : '1px solid #e7e4dc',
              color: '#8e968d',
              userSelect: 'none',
            },
            '.cm-activeLineGutter': { backgroundColor: dark ? '#283330' : '#ece8dd' },
            '.cm-activeLine': { backgroundColor: dark ? '#1b2623' : '#f3f0e6' },
            '.cm-line': { padding: '0 16px 0 10px' },
          }),
          ...(dark ? [oneDark] : []),
          ...(shouldWrap ? [EditorView.lineWrapping] : []),
        ],
      }),
    });

    viewRef.current = view;

    const lang = languages.find((l) =>
      l.extensions.includes(path.split('.').pop()?.toLowerCase() || ''),
    );
    lang
      ?.load()
      .then((extension) => {
        if (alive) view.dispatch({ effects: append.of(extension) });
      })
      .catch(() => {});

    if (line > 1) {
      scrollToLine(line);
    }

    if (onOutline) {
      const items: { name: string; line: number }[] = [];
      text.split('\n').forEach((value, i) => {
        const match = value.match(
          /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def|struct|fn|func)\s+([\w$]+)|^\s*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=.*=>/,
        );
        if (match) items.push({ name: match[1] || match[2], line: i + 1 });
      });
      onOutline(items.slice(0, 150));
    }

    return () => {
      alive = false;
      view.destroy();
      viewRef.current = null;
    };
  }, [text, path, dark, wrap, line]);

  return (
    <div className="code-reader-container">
      <div className="code-reader-toolbar">
        <div className="code-reader-status">
          <span>当前行: L{activeLine}</span>
          {annotations.length > 0 && (
            <span className="code-annotations-badge">
              <BookmarkCheck size={13} />
              {annotations.length} 条批注
            </span>
          )}
        </div>
        <button
          type="button"
          className="code-annotate-btn"
          onClick={() => handleOpenAnnotation(activeLine)}
          title="为当前行添加笔记或批注"
        >
          <MessageSquarePlus size={14} />
          <span>添加标注</span>
        </button>
      </div>

      <div className="code-reader" ref={root} />

      {annotations.length > 0 && !sheetOpen && (
        <div className="code-annotations-bar">
          <div className="annotations-title">代码批注记录:</div>
          <div className="annotations-pills">
            {annotations.map((a) => (
              <button
                key={a.id}
                type="button"
                className="annotation-pill"
                onClick={() => {
                  scrollToLine(a.line);
                  handleOpenAnnotation(a.line);
                }}
              >
                <strong>L{a.line}:</strong> {a.note.slice(0, 16)}
                {a.note.length > 16 ? '...' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {sheetOpen && (
        <>
          <div className="bottom-sheet-backdrop" onClick={() => setSheetOpen(false)} />
          <div className="code-annotation-drawer">
            <div className="drawer-header">
              <div className="drawer-title">
                <strong>代码批注 · 第 {activeLine} 行</strong>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={() => setSheetOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            {activeSnippet && (
              <div className="drawer-snippet">
                <code>{activeSnippet}</code>
              </div>
            )}

            <div className="drawer-body">
              <textarea
                className="drawer-input"
                autoFocus
                rows={4}
                placeholder="在此输入您的代码笔记、理解或疑问，支持调用中文系统输入法..."
                value={sheetInput}
                onChange={(e) => setSheetInput(e.target.value)}
              />
            </div>

            <div className="drawer-actions">
              {editingId && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => handleDeleteNote(editingId)}
                >
                  <Trash2 size={14} />
                  <span>删除批注</span>
                </button>
              )}
              <button
                type="button"
                className="button primary"
                disabled={!sheetInput.trim()}
                onClick={handleSaveNote}
              >
                <span>保存批注</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
