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
  assert.equal(all.find((node) => node.tagName === 'a')?.properties.href ?? '', '');
  assert.equal(all.find((node) => node.tagName === 'img')?.properties.src ?? '', '');
  assert.ok(all.some((node) => node.properties.href === 'folder/note.md'));
  assert.ok(!JSON.stringify(parsed).includes('globalThis.unsafe'));
});

test('safe HTML folds and line breaks render while code examples and technical tokens stay literal', () => {
  const source =
    '# HTML 排版\n\n<details>\n<summary>展开 <strong>说明</strong></summary>\n\n' +
    '## 内部标题\n\n折叠里的 **Markdown**。\n\n| 一 | 二 |\n| --- | --- |\n| 上<br>下 | 内容 |\n\n</details>\n\n' +
    '技术标记 <CR><LF>\n\n```html\n<details><summary>示例代码</summary></details>\n```';
  const parsed = parseMarkdown(source);
  const all = elements(parsed.chunks.flatMap((c) => c.tree.children));
  const fold = all.find((el) => el.tagName === 'details')!;
  assert.ok(fold);
  assert.equal(fold.properties['data-source-line'], 3);
  assert.equal(all.filter((el) => el.tagName === 'details').length, 1);
  assert.ok(elements(fold.children).some((el) => el.tagName === 'strong'));
  assert.ok(elements(fold.children).some((el) => el.tagName === 'table'));
  assert.equal(all.filter((el) => el.tagName === 'br').length, 1);
  assert.ok(JSON.stringify(parsed).includes('<CR><LF>'));
  assert.ok(JSON.stringify(parsed).includes('示例代码'));
  assert.equal(parsed.outline.find((h) => h.name === '内部标题')?.line, 6);
  assert.deepEqual(structuredClone(parsed), parsed);
});

test('frontmatter is omitted and Obsidian callouts retain formatted titles, bodies and fold state', () => {
  const source =
    '---\ntitle: hidden-metadata\ntags: [fixture]\n---\n\n# 正文\n\n' +
    '> [!note]\n> 正常 **内容**。\n\n> [!warning]+ 自定义 **标题**\n> 展开的正文\n\n' +
    '> [!tip]-\n> 折叠的正文\n\n```text\n> [!note] 保留代码示例\n```';
  const parsed = parseMarkdown(source);
  const all = elements(parsed.chunks.flatMap((c) => c.tree.children));
  const callouts = all.filter((el) =>
    (el.properties.className as string[] | undefined)?.includes('markdown-callout'),
  );
  assert.equal(callouts.length, 3);
  assert.equal(callouts[0].tagName, 'aside');
  assert.equal(callouts[0].properties.dataCallout, 'note');
  assert.equal(callouts[1].tagName, 'details');
  assert.equal(callouts[1].properties.open, true);
  assert.ok(!callouts[2].properties.open);
  assert.ok(!JSON.stringify(parsed).includes('hidden-metadata'));
  assert.equal(parsed.outline[0].line, 6);
  assert.equal(all.filter((el) => el.tagName === 'strong').length, 2);
  assert.ok(JSON.stringify(parsed).includes('保留代码示例'));
});

test('inline and display formulas render with local source positions and untrusted TeX cannot create links', () => {
  const source =
    '# 公式\n\n行内 $a \\times b$，代码 `$literal$`。\n\n$$\n\\frac{a}{b}\n$$\n\n' +
    '$\\href{javascript:alert(1)}{危险}$\n\n```text\n$$not math$$\n```';
  const parsed = parseMarkdown(source);
  const all = elements(parsed.chunks.flatMap((c) => c.tree.children));
  const classes = (el: (typeof all)[number]) => el.properties.className as string[] | undefined;
  assert.ok(all.some((el) => classes(el)?.includes('katex')));
  assert.equal(all.filter((el) => classes(el)?.includes('katex-display')).length, 1);
  assert.equal(
    all.find((el) => classes(el)?.includes('markdown-math-block'))?.properties['data-source-line'],
    5,
  );
  assert.ok(!all.some((el) => el.tagName === 'a'));
  assert.ok(JSON.stringify(parsed).includes('$literal$'));
  assert.ok(JSON.stringify(parsed).includes('$$not math$$'));
  assert.deepEqual(structuredClone(parsed), parsed);
});

test('formatted HTML cannot execute scripts, inject styles, load frames or enable form inputs', () => {
  const parsed = parseMarkdown(
    '<details open onclick="alert(1)"><summary>安全标题</summary>\n\n正文\n\n</details>\n\n' +
      '<style>body{display:none}</style>\n<iframe src="https://example.com"></iframe>\n' +
      '<img src="javascript:alert(1)" onerror="alert(1)">\n' +
      '<input type="text" autofocus>\n\n<span style="position:fixed;inset:0" id="location">文字</span>',
  );
  const all = elements(parsed.chunks.flatMap((c) => c.tree.children));
  assert.ok(
    !all.some((el) => ['script', 'style', 'iframe', 'object', 'form'].includes(el.tagName)),
  );
  assert.ok(
    !all.some((el) =>
      Object.keys(el.properties).some((key) => /^on/i.test(key) || key === 'style'),
    ),
  );
  assert.ok(!all.some((el) => el.properties.src === 'javascript:alert(1)'));
  const input = all.find((el) => el.tagName === 'input');
  assert.equal(input?.properties.disabled, true);
  assert.equal(input?.properties.type, 'checkbox');
  assert.ok(!JSON.stringify(parsed).includes('body{display:none}'));
  assert.ok(all.some((el) => el.properties.id === 'user-content-location'));
});

test('Obsidian highlights, comments, image sizes and line breaks preserve code and source lines', () => {
  const source =
    '# Title\n\n第一行\n第二行 ==重点 **加粗**==\n\n' +
    '%% hidden\n\n# hidden heading\n\n**secret** %%\n\n' +
    '## Visible\n\n![[photo.png|240x120]]\n\n' +
    '`==literal== %%code%%`\n\n```ts\nconst example = "%%literal%% ==plain==";\n```\n\n' +
    '\\==escaped==\n\nUnclosed ==marker\n';
  const parsed = parseMarkdown(source);
  const all = elements(parsed.chunks.flatMap((chunk) => chunk.tree.children));
  assert.equal(all.filter((el) => el.tagName === 'mark').length, 1);
  const mark = all.find((el) => el.tagName === 'mark')!;
  assert.ok(elements(mark.children).some((el) => el.tagName === 'strong'));
  assert.ok(all.some((el) => el.tagName === 'br'));
  assert.ok(!JSON.stringify(parsed).includes('secret'));
  assert.deepEqual(
    parsed.outline.map((item) => item.name),
    ['Title', 'Visible'],
  );
  assert.equal(parsed.outline[1].line, source.split('\n').indexOf('## Visible') + 1);
  const image = all.find((el) => el.tagName === 'img')!;
  assert.equal(image.properties.width, 240);
  assert.equal(image.properties.height, 120);
  assert.ok(JSON.stringify(parsed).includes('%%literal%% ==plain=='));
  assert.ok(JSON.stringify(parsed).includes('==literal== %%code%%'));
  assert.ok(JSON.stringify(parsed).includes('Unclosed ==marker'));
});
