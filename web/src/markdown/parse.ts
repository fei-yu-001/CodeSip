import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import { remarkCallouts } from './callouts';
import {
  rehypeSanitize,
  readerSchema,
  preserveLiteralTags,
  mathSourcePositions,
} from './formatting';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import { defaultUrlTransform } from 'react-markdown';
import { urlAttributes } from 'html-url-attributes';
import type { Root as MdastRoot, RootContent as MdastContent } from 'mdast';
import type { Root, RootContent, Element } from 'hast';
import type { MarkdownDocument, MarkdownChunk } from './types';

// Keep the same dialect as the reader, including references defined later in a note.
// Parsing individual slices would break fences, tables, lists and link definitions.
function wikiLinks() {
  return (tree: MdastRoot) => {
    const visit = (node: MdastRoot | MdastContent) => {
      if (!('children' in node) || ['code', 'inlineCode', 'link', 'image'].includes(node.type))
        return;
      node.children = node.children.flatMap((child): any[] => {
        if (child.type !== 'text') {
          visit(child);
          return [child];
        }
        const pieces: MdastContent[] = [];
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
      }) as typeof node.children;
    };
    visit(tree);
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter)
  .use(remarkMath)
  .use(wikiLinks)
  .use(remarkCallouts)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(preserveLiteralTags)
  .use(rehypeRaw)
  .use(rehypeSanitize, readerSchema)
  .use(mathSourcePositions)
  .use(rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20 })
  .use(rehypeHighlight, { detect: false, ignoreMissing: true })
  .freeze();

function nodeText(node: RootContent): string {
  return node.type === 'text'
    ? node.value
    : 'children' in node
      ? node.children.map(nodeText).join('')
      : '';
}

export function parseMarkdown(text: string): MarkdownDocument {
  const tree = processor.runSync(processor.parse(text)) as Root;
  const outline: MarkdownDocument['outline'] = [];
  const chunks: MarkdownChunk[] = [];
  // Bound ordinary commits by AST work, not source bytes (highlighted code expands greatly).
  const budget = 600;
  let children: RootContent[] = [];
  let weight = 0;
  let startLine = 1;
  let endLine = 1;
  const flush = () => {
    if (!children.length) return;
    chunks.push({ tree: { type: 'root', children }, startLine, endLine });
    children = [];
    weight = 0;
  };
  const prepare = (node: RootContent): { node: RootContent; weight: number } => {
    // Defensive fallback: unparsed nodes can only become text, never executable HTML.
    if (node.type === 'raw') return { node: { type: 'text', value: node.value }, weight: 1 };
    let count = 1;
    if (node.type === 'element') {
      if (
        (/^(h[1-6]|p|pre|blockquote|table|li|details|summary|aside)$/.test(node.tagName) ||
          (node.properties.className as string[] | undefined)?.includes('markdown-math-block')) &&
        node.position
      ) {
        node.properties['data-source-line'] = node.position.start.line;
        if (/^h[1-6]$/.test(node.tagName))
          outline.push({
            name: nodeText(node),
            line: node.position.start.line,
            level: Number(node.tagName[1]),
          });
      }
      for (const [key, tags] of Object.entries(urlAttributes)) {
        if (Object.hasOwn(node.properties, key) && (tags === null || tags.includes(node.tagName)))
          node.properties[key] = defaultUrlTransform(String(node.properties[key] || ''));
      }
      node.children = node.children.map((child) => {
        const prepared = prepare(child);
        count += prepared.weight;
        return prepared.node as Element['children'][number];
      });
    }
    // Only block positions are used by components. Avoid cloning thousands of offsets.
    if (node.type !== 'element' || !node.properties['data-source-line']) delete node.position;
    return { node, weight: count };
  };
  for (const child of tree.children) {
    const first = child.position?.start.line ?? endLine;
    const last = child.position?.end.line ?? first;
    const prepared = prepare(child);
    if (children.length && weight + prepared.weight > budget) flush();
    if (!children.length) startLine = first;
    children.push(prepared.node);
    weight += prepared.weight;
    endLine = last;
  }
  flush();
  return { chunks, outline };
}
