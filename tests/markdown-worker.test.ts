import assert from 'node:assert/strict';
import test from 'node:test';
import type { RootContent } from 'hast';
import { parseMarkdown } from '../web/src/markdown/parse';

function elements(nodes: RootContent[]): Extract<RootContent, { type: 'element' }>[] {
  return nodes.flatMap((node) =>
    node.type === 'element' ? [node, ...elements(node.children)] : [],
  );
}
test('worker parser preserves whole-document references, GFM, wiki links and source lines across chunks', () => {
  const source =
    '# **开始**\n\n[后面的定义][target]\n\n' +
    Array.from({ length: 110 }, (_, i) => `## 章节 ${i}\n\n段落 **强调**。\n\n`).join('') +
    '末尾标题\n--------\n\n| 列一 | 列二 |\n| --- | --- |\n| 值 | 值 |\n\n' +
    '- [x] 已读\n- [ ] 待读\n\n[[目标|别名]] ![[图.png]]\n\n' +
    '```ts\n// # 假标题\nconst x = 1;\n```\n\n[target]: https://example.com/reference\n';
  const parsed = parseMarkdown(source);
  assert.ok(parsed.chunks.length > 1);
  const all = elements(parsed.chunks.flatMap((chunk) => chunk.tree.children));
  assert.equal(
    all.find((el) => el.tagName === 'a')?.properties.href,
    'https://example.com/reference',
  );
  assert.ok(all.some((el) => el.tagName === 'table'));
  assert.equal(
    all.filter((el) => el.tagName === 'input' && el.properties.type === 'checkbox').length,
    2,
  );
  assert.ok(all.some((el) => el.tagName === 'a' && el.properties.href === encodeURI('目标')));
  assert.ok(all.some((el) => el.tagName === 'img' && el.properties.src === encodeURI('图.png')));
  assert.ok(
    all.some((el) => (el.properties.className as string[] | undefined)?.includes('hljs-keyword')),
  );
  assert.equal(parsed.outline.length, 112);
  assert.equal(parsed.outline[0].name, '开始');
  assert.equal(parsed.outline.at(-1)?.name, '末尾标题');
  const lines = source.split('\n');
  for (const heading of parsed.outline) assert.ok(lines[heading.line - 1].includes(heading.name));
  for (let i = 1; i < parsed.chunks.length; i++)
    assert.ok(parsed.chunks[i].startLine >= parsed.chunks[i - 1].endLine);
  // The payload must be safe to clone into a Worker and contains no React/function objects.
  assert.deepEqual(structuredClone(parsed), parsed);
});

test('worker parser keeps imported HTML inert and rejects executable URL protocols', () => {
  const parsed = parseMarkdown(
    '<script>globalThis.unsafe=true</script>\n\n' +
      '[bad](javascript:alert%281%29) ![bad](data:text/html;base64,ZXZpbA==)\n\n' +
      '<img src=x onerror=alert(1)>\n\n[relative](folder/note.md) [email](mailto:reader@example.com)',
  );
  const all = elements(parsed.chunks.flatMap((chunk) => chunk.tree.children));
  assert.ok(!all.some((node) => node.tagName === 'script'));
  assert.ok(!all.some((node) => Object.keys(node.properties).some((key) => /^on/i.test(key))));
  assert.equal(all.find((node) => node.tagName === 'a')?.properties.href, '');
  assert.equal(all.find((node) => node.tagName === 'img')?.properties.src, '');
  assert.ok(all.some((node) => node.properties.href === 'folder/note.md'));
  assert.ok(JSON.stringify(parsed).includes('<script>globalThis.unsafe=true</script>'));
});
