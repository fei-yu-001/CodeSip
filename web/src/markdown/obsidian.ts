import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import type { Root, RootContent, PhrasingContent, Emphasis } from 'mdast';

const sourceParser = unified().use(remarkParse).use(remarkMath).use(remarkFrontmatter).freeze();

// Remove comments before Markdown parsing, retaining source line numbers. Code and
// math examples keep literal %% delimiters; comment bodies cannot create headings.
export function stripObsidianComments(source: string): string {
  if (!source.includes('%%')) return source;
  const protectedRanges: [number, number][] = [];
  const collect = (node: Root | RootContent) => {
    if (['code', 'inlineCode', 'math', 'inlineMath', 'yaml'].includes(node.type) && node.position) {
      protectedRanges.push([node.position.start.offset!, node.position.end.offset!]);
      return;
    }
    if ('children' in node) node.children.forEach((child) => collect(child as RootContent));
  };
  collect(sourceParser.parse(source));
  protectedRanges.sort((a, b) => a[0] - b[0]);
  const escaped = (at: number) => {
    let count = 0;
    while (source[at - count - 1] === '\\') count++;
    return count % 2 === 1;
  };
  let range = 0;
  let start = 0;
  let result = '';
  for (let at = source.indexOf('%%'); at !== -1; at = source.indexOf('%%', at + 2)) {
    while (protectedRanges[range]?.[1] <= at) range++;
    if (
      escaped(at) ||
      (protectedRanges[range] && at >= protectedRanges[range][0] && at < protectedRanges[range][1])
    )
      continue;
    let end = source.indexOf('%%', at + 2);
    while (end !== -1 && escaped(end)) end = source.indexOf('%%', end + 2);
    if (end === -1) break;
    result += source.slice(start, at) + source.slice(at, end + 2).replace(/[^\r\n]/g, '');
    start = end + 2;
    at = end;
  }
  return result + source.slice(start);
}

/** Obsidian reading mode: inline highlights and soft line breaks. */
export function remarkObsidian() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: Root | RootContent) => {
      if (!('children' in node)) return;
      node.children.forEach((child) => visit(child as RootContent));
      if (!['paragraph', 'heading', 'tableCell'].includes(node.type)) return;
      const children = node.children as PhrasingContent[];
      const output: PhrasingContent[] = [];
      let highlighted: PhrasingContent[] | null = null;
      const append = (child: PhrasingContent) => (highlighted || output).push(child);
      for (const child of children) {
        if (child.type !== 'text') {
          append(child);
          continue;
        }
        const raw = child.position
          ? source.slice(child.position.start.offset, child.position.end.offset)
          : '';
        // CommonMark has already unescaped these. Keep escaped markers literal.
        const parts = raw.includes('\\==') ? [child.value] : child.value.split(/(==)/g);
        for (const part of parts) {
          if (part === '==') {
            if (highlighted) {
              const mark: Emphasis = {
                type: 'emphasis',
                data: { hName: 'mark' },
                children: highlighted,
              };
              output.push(mark);
              highlighted = null;
            } else highlighted = [];
          } else if (part) append({ type: 'text', value: part });
        }
      }
      if (highlighted) output.push({ type: 'text', value: '==' }, ...highlighted);
      const breaks = (items: PhrasingContent[]): PhrasingContent[] =>
        items.flatMap((child) => {
          if (child.type === 'emphasis' && child.data?.hName === 'mark')
            return [{ ...child, children: breaks(child.children) }];
          if (child.type !== 'text' || !child.value.includes('\n')) return [child];
          return child.value
            .split('\n')
            .flatMap((value, index): PhrasingContent[] => [
              ...(index ? [{ type: 'break' } as PhrasingContent] : []),
              { type: 'text', value },
            ]);
        });
      node.children = breaks(output) as typeof node.children;
    };
    visit(tree);
  };
}
