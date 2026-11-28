import type { Blockquote, Paragraph, PhrasingContent, Root, RootContent } from 'mdast';

const titles: Record<string, string> = {
  note: '笔记',
  info: '信息',
  tip: '提示',
  hint: '提示',
  warning: '注意',
  caution: '注意',
  important: '重要',
  danger: '警告',
  error: '错误',
  success: '完成',
  question: '问题',
  example: '示例',
  quote: '引用',
  abstract: '摘要',
  summary: '摘要',
  todo: '待办',
};

/** Keep callout bodies as Markdown; only the marker and first line form the title. */
export function remarkCallouts() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === 'blockquote') transform(node);
      if ('children' in node) for (const child of node.children) visit(child as RootContent);
    };
    visit(tree);
  };
}
function transform(node: Blockquote) {
  const first = node.children[0];
  if (first?.type !== 'paragraph' || first.children[0]?.type !== 'text') return;
  const marker = /^\[!([\w-]+)\]([+-])?[ \t]*/.exec(first.children[0].value);
  if (!marker) return;
  const kind = marker[1].toLowerCase();
  const title: PhrasingContent[] = [];
  const body: PhrasingContent[] = [];
  let inBody = false;
  for (const [index, child] of first.children.entries()) {
    if (inBody) {
      body.push(child);
      continue;
    }
    if (child.type === 'break') {
      inBody = true;
      continue;
    }
    if (child.type !== 'text') {
      title.push(child);
      continue;
    }
    const value = index === 0 ? child.value.slice(marker[0].length) : child.value;
    const newline = value.indexOf('\n');
    if (newline === -1) {
      if (value) title.push({ ...child, value });
    } else {
      if (newline) title.push({ ...child, value: value.slice(0, newline) });
      if (value.slice(newline + 1)) body.push({ ...child, value: value.slice(newline + 1) });
      inBody = true;
    }
  }
  const fold = marker[2];
  node.data = {
    ...node.data,
    hName: fold ? 'details' : 'aside',
    hProperties: {
      className: ['markdown-callout'],
      dataCallout: kind,
      ...(fold === '+' ? { open: true } : {}),
    },
  };
  const heading: Paragraph = {
    type: 'paragraph',
    position: first.position,
    data: {
      hName: fold ? 'summary' : 'div',
      hProperties: { className: ['markdown-callout-title'] },
    },
    children: title.length ? title : [{ type: 'text', value: titles[kind] || kind }],
  };
  const paragraph: Paragraph = { type: 'paragraph', children: body };
  if (first.position)
    paragraph.position = {
      ...first.position,
      start: { line: first.position.start.line + 1, column: 1 },
    };
  node.children = [heading, ...(body.length ? [paragraph] : []), ...node.children.slice(1)];
}
