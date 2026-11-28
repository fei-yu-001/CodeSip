import { test, expect } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
const origin = 'http://127.0.0.1:4319';
let libraryId = '';
test.beforeEach(async ({ page }) => {
  const needsSetup = (await (await page.request.get('/api/status')).json()).needsSetup;
  const login = await page.request.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    headers: { origin },
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(needsSetup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  expect(login.ok()).toBeTruthy();
  const files = {
    'src/example.ts': Array.from(
      { length: 220 },
      (_, i) => `export const value${i} = "${'reader '.repeat(12)}";`,
    ).join('\n'),
    'src/other.ts': 'export const other = true;',
    'note.md': '# 阅读空间\n\n' + '这是一段用于布局验证的笔记。\n\n'.repeat(30),
  };
  const response = await page.request.post('/api/import?kind=code&name=layout-navigation', {
    headers: { origin },
    multipart: {
      file: {
        name: 'layout-navigation.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync(
            Object.fromEntries(
              Object.entries(files).map(([path, content]) => [path, strToU8(content)]),
            ),
          ),
        ),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  libraryId = (await response.json()).library.id;
});
test.afterEach(async ({ page }) => {
  if (libraryId) await page.request.delete(`/api/libraries/${libraryId}`, { headers: { origin } });
});

test('directory is visible on desktop and thumb-accessible on mobile without narrowing code', async ({
  page,
}, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 373, height: 755 });
  await page.goto(`/#code/${libraryId}?file=src%2Fexample.ts`);
  const panel = page.locator('.reader-panel:not([hidden])');
  await expect(panel.locator('.cm-editor')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  const reader = await panel.locator('.cm-scroller').boundingBox();
  expect(reader).not.toBeNull();
  if (info.project.name === 'mobile') {
    expect(reader!.width).toBeGreaterThanOrEqual(370);
    expect(reader!.height).toBeGreaterThanOrEqual(660);
    await expect(page.getByRole('button', { name: '打开目录', exact: true })).toContainText('目录');
    const quick = page.getByRole('button', { name: '浏览文件目录', exact: true });
    expect((await quick.boundingBox())!.y).toBeGreaterThan(600);
    await quick.click();
    await expect(page.locator('.file-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.file-panel')).toBeHidden();
    await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
    await quick.click();
  } else {
    expect(reader!.width).toBeGreaterThan(1180);
    await expect(page.locator('.file-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: '切换明暗主题', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '账号与退出', exact: true })).toBeVisible();
  }
  await page.locator('.tree-file').filter({ hasText: 'other.ts' }).click();
  await expect(panel.locator('.cm-content')).toContainText('export const other');
  await expect(page.getByRole('tab', { name: 'example.ts', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '专注阅读', exact: true }).click();
    await expect(page.getByRole('button', { name: '浏览文件目录', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '退出专注阅读', exact: true })).toBeVisible();
  }
});

test('wide Markdown uses available space and remembers the reading preference', async ({
  page,
}, info) => {
  await page.goto(`/#code/${libraryId}?file=note.md`);
  const content = page.locator('.reader-panel:not([hidden]) .markdown-content');
  await expect(content).toContainText('阅读空间');
  const before = (await content.boundingBox())!.width;
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByRole('button', { name: '铺满', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('article.reading-wide')).toBeVisible();
  if (info.project.name === 'desktop')
    expect((await content.boundingBox())!.width).toBeGreaterThan(before + 300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.reload();
  await expect(page.locator('article.reading-wide')).toBeVisible();
});

test('missing project has persistent recovery actions and retry can open the same project', async ({
  page,
}) => {
  let missing = true;
  await page.route(`**/api/libraries/${libraryId}/manifest`, async (route) => {
    if (missing)
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: '找不到这个项目' }),
      });
    else await route.continue();
  });
  await page.goto(`/#code/${libraryId}?file=src%2Fexample.ts`);
  const error = page.locator('.reader-empty[role=alert]');
  await expect(error).toContainText('找不到这个项目');
  await expect(error.locator('.spin')).toHaveCount(0);
  await expect(error.getByRole('button', { name: '回到项目列表', exact: true })).toBeVisible();
  missing = false;
  await error.getByRole('button', { name: '重试打开项目', exact: true }).click();
  await expect(page.locator('.reader-panel:not([hidden]) .cm-content')).toContainText(
    'export const value',
  );
  await expect(error).toHaveCount(0);
});
