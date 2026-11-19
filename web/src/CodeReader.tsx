import { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
export default function CodeReader({
  text,
  path,
  dark = false,
  wrap = false,
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
          EditorView.theme({
            '&': { fontSize: '13px', height: '100%' },
            '.cm-scroller': {
              fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
              lineHeight: '1.8',
              overflow: 'auto',
            },
            '.cm-content': { padding: '20px 0' },
            '.cm-gutters': {
              backgroundColor: dark ? '#202824' : '#fafbf7',
              border: 'none',
              color: '#a3aaa1',
            },
            '.cm-activeLineGutter': { backgroundColor: 'transparent' },
            '.cm-activeLine': { backgroundColor: 'transparent' },
            '.cm-line': { padding: '0 24px 0 14px' },
          }),
          ...(dark ? [oneDark] : []),
          ...(wrap ? [EditorView.lineWrapping] : []),
        ],
      }),
    });
    const lang = languages.find((l) =>
      l.extensions.includes(path.split('.').pop()?.toLowerCase() || ''),
    );
    lang
      ?.load()
      .then((extension) => {
        if (alive) view.dispatch({ effects: append.of(extension) });
      })
      .catch(() => {});
    if (line > 1)
      view.dispatch({
        effects: EditorView.scrollIntoView(
          Math.min(
            view.state.doc.length,
            view.state.doc.line(Math.min(line, view.state.doc.lines)).from,
          ),
          { y: 'center' },
        ),
      });
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
    };
  }, [text, path, dark, wrap, line]);
  return <div className="code-reader" ref={root} />;
}
import { StateEffect } from '@codemirror/state';
const append = StateEffect.appendConfig;
