import { test, expect, type BrowserContext } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
const origin = 'http://127.0.0.1:4319';
let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
let fixtureLibrary: string | undefined;
const source = `---
title: metadata-only-title
tags: [fixture]
---

# 格式兼容测试

行内公式 $a \\times b$ 与 **粗体**。

$$
\\frac{a+b}{c}
$$

<details>
<summary>查看折叠说明</summary>

折叠中的 **加粗正文**。

<details>
<summary>内层说明</summary>

## 折叠内标题

能够通过目录定位。

</details>

</details>

| 标题 | 说明 |
| --- | --- |
| 换行 | 第一行<br>第二行 |

> [!note] 阅读提示
> 保留 **提示正文**。

> [!warning]- 点击查看注意事项
> 折叠的提醒正文。

技术记号 <CR><LF>。

\`\`\`html
<details><summary>HTML 代码示例</summary></details>
\`\`\`

<script>globalThis.markdownExecuted=true</script>
<img src="javascript:alert(1)" onerror="globalThis.markdownExecuted=true">
<style>body{display:none}</style>
`;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: origin });
  const needsSetup = (await (await request.get('/api/status')).json()).needsSetup;
  const result = await request.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    headers: { origin },
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(needsSetup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  expect(result.ok()).toBeTruthy();
  cookies = (await request.storageState()).cookies;
  await request.dispose();
});

test.beforeEach(async ({ page, context }) => {
  await context.addCookies(cookies);
  const result = await page.request.post(
    '/api/import?kind=notes&name=markdown-formatting-fixture',
    {
      headers: { origin },
      multipart: {
        file: {
          name: 'formatting.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from(zipSync({ 'formatting.md': strToU8(source) })),
        },
      },
    },
  );
  expect(result.ok()).toBeTruthy();
  const { library } = await result.json();
  fixtureLibrary = library.id;
  await page.goto(`/#notes/${library.id}?file=formatting.md`);
  await expect(page.locator('.markdown-content')).toHaveAttribute('data-render-complete', 'true');
});

test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  if (fixtureLibrary) {
    const result = await page.request.delete(`/api/libraries/${fixtureLibrary}`, {
      headers: { origin },
    });
    fixtureLibrary = undefined;
    expect(result.ok()).toBeTruthy();
  }
});

test('HTML folds, math, callouts and line breaks render safely and remain available offline', async ({
  page,
  context,
}) => {
  const content = page.locator('.markdown-content');
  await expect(content).not.toContainText('metadata-only-title');
  await expect(content.locator('details')).toHaveCount(3);
  await expect(content.getByText('加粗正文', { exact: true })).toBeHidden();
  await content.locator('summary').filter({ hasText: '查看折叠说明' }).click();
  await expect(content.getByText('加粗正文', { exact: true })).toBeVisible();
  await expect(content.locator('.katex')).toHaveCount(2);
  await expect(content.locator('.katex-display')).toBeVisible();
  await expect(content.locator('.markdown-callout')).toHaveCount(2);
  await expect(content.getByText('提示正文', { exact: true })).toBeVisible();
  await expect(content.getByText('折叠的提醒正文。', { exact: true })).toBeHidden();
  await content.locator('summary').filter({ hasText: '点击查看注意事项' }).click();
  await expect(content.getByText('折叠的提醒正文。', { exact: true })).toBeVisible();
  await expect(content.locator('td br')).toHaveCount(1);
  await expect(content).toContainText('<CR><LF>');
  await expect(content.locator('.code-block-source')).toContainText(
    '<details><summary>HTML 代码示例</summary></details>',
  );
  await expect(content.locator('script, style, iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).markdownExecuted)).toBeUndefined();
  expect(await content.locator('[onclick], [onerror], [onload]').count()).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(async () => {
      const fonts = await document.fonts.load('16px KaTeX_Main');
      return fonts.length > 0 && fonts.every((font) => font.status === 'loaded');
    }),
  ).toBeTruthy();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBeTruthy();
  await page.getByRole('button', { name: '保存离线', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存离线', exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(content).toHaveAttribute('data-render-complete', 'true');
  await expect(content.locator('details')).toHaveCount(3);
  await expect(content.locator('.katex')).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(async () => {
      const fonts = await document.fonts.load('16px KaTeX_Main');
      return fonts.length > 0 && fonts.every((font) => font.status === 'loaded');
    }),
  ).toBeTruthy();
  await content.locator('summary').filter({ hasText: '查看折叠说明' }).click();
  await expect(content.getByText('加粗正文', { exact: true })).toBeVisible();
});

test('outline jumps reveal nested collapsed HTML and retain the original Markdown source line', async ({
  page,
}) => {
  const heading = page.getByRole('heading', { name: '折叠内标题', exact: true });
  await expect(heading).toBeHidden();
  await page.getByRole('button', { name: '文件大纲', exact: true }).click();
  await page.locator('.outline').getByRole('button', { name: '折叠内标题', exact: true }).click();
  await expect(heading).toBeVisible();
  await expect(heading).toBeInViewport();
  await expect(heading).toHaveAttribute(
    'data-source-line',
    String(source.split('\n').findIndex((l) => l === '## 折叠内标题') + 1),
  );
  expect(
    await heading.evaluate((el) => {
      let node = el.parentElement;
      let open = 0;
      while (node) {
        if (node instanceof HTMLDetailsElement && node.open) open++;
        node = node.parentElement;
      }
      return open;
    }),
  ).toBe(2);
});
