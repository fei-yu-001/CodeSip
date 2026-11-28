import rehypeSanitize, { defaultSchema, type Options } from 'rehype-sanitize';
import type { Element, Root } from 'hast';

export { rehypeSanitize };
export const readerSchema: Options = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames!, 'aside', 'mark'],
  strip: [...defaultSchema.strip!, 'style', 'iframe', 'object', 'embed', 'template', 'form'],
  attributes: {
    ...defaultSchema.attributes,
    img: [...defaultSchema.attributes!.img, 'width', 'height'],
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    aside: [['className', 'markdown-callout'], 'dataCallout'],
    details: [['className', 'markdown-callout'], 'dataCallout', 'open'],
    summary: [...defaultSchema.attributes!.summary, ['className', 'markdown-callout-title']],
    div: [...defaultSchema.attributes!.div, ['className', 'markdown-callout-title']],
  },
};

// Angle-bracket tokens such as <CR><LF> are prose in technical notes, not HTML.
// Retain unknown tags literally while recognized HTML is parsed and sanitized.
export function preserveLiteralTags() {
  const known = new Set([...readerSchema.tagNames!, ...readerSchema.strip!]);
  return (tree: Root) => {
    const visit = (node: Root | Root['children'][number]) => {
      if (node.type === 'raw') {
        node.value = node.value.replace(/<\/?([a-z][\w-]*)\b[^>]*>/gi, (tag, name: string) =>
          known.has(name.toLowerCase()) ? tag : tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        );
      }
      if ('children' in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

/** KaTeX replaces the pre element; retain its source position on a block wrapper. */
export function mathSourcePositions() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      node.children = node.children.map((child) => {
        if (child.type !== 'element') return child;
        const code = child.children[0];
        if (
          child.tagName === 'pre' &&
          code?.type === 'element' &&
          (code.properties.className as string[] | undefined)?.some(
            (c) => c === 'math-display' || c === 'language-math',
          )
        ) {
          return {
            type: 'element',
            tagName: 'div',
            properties: { className: ['markdown-math-block'] },
            position: child.position,
            children: [child],
          } satisfies Element;
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}
