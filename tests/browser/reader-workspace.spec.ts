import { closeReaderTools, readerControl } from './reader-controls';
import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
const origin = 'http://127.0.0.1:4319';
let cookies: any[] = [];
let libraryId = '';
const code =
  'export function preserved() {\n' +
  Array.from({ length: 180 }, (_, i) => `  const value${i} = "${'long code '.repeat(14)}";`).join(
    '\n',
  ) +
  '\n}\n';
const note =
  '# Obsidian\n\n第一行\n第二行 ==重点 **内容**==\n\n%% hidden\n# Secret heading\n%%\n\n' +
  '> [!note]- 折叠内容\n> 可保留的展开状态\n\n[[other#Target|跳到章节]]\n\n' +
  Array.from({ length: 70 }, (_, i) => `段落 ${i}\n\n`).join('');
const archive = (files: Record<string, string>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])),
    ),
  );
test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: origin });
  const needsSetup = (await (await request.get('/api/status')).json()).needsSetup;
  const response = await request.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    headers: { origin },
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(needsSetup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  cookies = (await request.storageState()).cookies;
  await request.dispose();
});
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(cookies);
  const response = await page.request.post('/api/import?kind=notes&name=reader-fixes', {
    headers: { origin },
    multipart: {
      file: {
        name: 'reader-fixes.zip',
        mimeType: 'application/zip',
        buffer: archive({
          'note.md': note,
          'other.md': '# Other\n\n' + 'Spacer\n\n'.repeat(45) + '## Target\n\nArrived',
          'code.ts': code,
        }),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  libraryId = (await response.json()).library.id;
});
test.afterEach(async ({ page }) => {
  if (libraryId) await page.request.delete(`/api/libraries/${libraryId}`, { headers: { origin } });
});
const panel = (page: Page) => page.locator('.reader-panel:not([hidden])');
async function open(page: Page, path: string) {
  await page.evaluate(
    (hash) => {
      location.hash = hash;
    },
    `notes/${libraryId}?file=${encodeURIComponent(path)}`,
  );
}

test('tabs retain mounted readers, scroll and folds across files and home navigation', async ({
  page,
}) => {
  await page.goto(`/#notes/${libraryId}?file=note.md`);
  await expect(panel(page).locator('.markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
  );
  await expect(panel(page).locator('mark')).toHaveText('重点 内容');
  await expect(panel(page).locator('p br').first()).toBeAttached();
  await expect(panel(page)).not.toContainText('Secret heading');
  await panel(page).locator('summary').click();
  await panel(page)
    .locator('article')
    .evaluate((element) => {
      (window as any).originalArticle = element;
      element.scrollTop = 700;
    });
  await expect
    .poll(() =>
      panel(page)
        .locator('article')
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(600);
  await open(page, 'code.ts');
  await expect(panel(page).locator('.cm-editor')).toBeVisible();
  const reads: string[] = [];
  page.on('request', (request) => {
    if (/\/file\?/.test(request.url())) reads.push(request.url());
  });
  await page.getByRole('tab', { name: 'note.md', exact: true }).click();
  await expect
    .poll(() =>
      panel(page)
        .locator('article')
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(600);
  expect(
    await panel(page)
      .locator('article')
      .evaluate((element) => element === (window as any).originalArticle),
  ).toBeTruthy();
  await expect(panel(page).locator('details')).toHaveAttribute('open', '');
  await page.evaluate(() => {
    location.hash = 'notes';
  });
  await expect(page.locator('.reader-layout')).toBeHidden();
  await open(page, 'note.md');
  await expect(panel(page).locator('article')).toBeVisible();
  expect(
    await panel(page)
      .locator('article')
      .evaluate((element) => element === (window as any).originalArticle),
  ).toBeTruthy();
  await expect
    .poll(() =>
      panel(page)
        .locator('article')
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(600);
  expect(reads).toHaveLength(0);
  await page.getByRole('button', { name: '关闭文件 code.ts', exact: true }).click();
  await expect(page.locator('.reader-tabs [role=tab]')).toHaveCount(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
});

test('code zoom reconfigures the existing read-only reader and keeps fold and scroll state', async ({
  page,
}) => {
  await page.goto(`/#notes/${libraryId}?file=code.ts`);
  await expect(panel(page).locator('.cm-editor')).toBeVisible();
  const editor = panel(page).locator('.cm-editor');
  await editor.evaluate((element) => {
    (window as any).originalEditor = element;
  });
  await panel(page).getByRole('button', { name: '放大代码', exact: true }).click();
  await expect(editor).toHaveCSS('font-size', '15px');
  await panel(page).getByRole('button', { name: '缩小代码', exact: true }).click();
  await expect(editor).toHaveCSS('font-size', '14px');
  await expect(editor.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await (await readerControl(page, '自动换行')).click();
  await closeReaderTools(page);
  // Use real input: a new user scroll must take precedence over pending zoom or
  // wrap measurements, rather than racing them with a synthetic scrollTop write.
  await editor.locator('.cm-scroller').hover();
  await page.mouse.wheel(120, 700);
  await expect
    .poll(() => editor.locator('.cm-scroller').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(600);
  await open(page, 'note.md');
  await expect(panel(page).locator('.markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
  );
  await page.getByRole('tab', { name: 'code.ts', exact: true }).click();
  await expect(editor).toBeVisible();
  expect(
    await editor.evaluate((element) => element === (window as any).originalEditor),
  ).toBeTruthy();
  await expect
    .poll(() => editor.locator('.cm-scroller').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(600);
  await editor.locator('.cm-scroller').evaluate((element) => {
    element.scrollTop = 0;
  });
  await editor.locator('.cm-foldGutter .cm-gutterElement').filter({ hasText: '⌄' }).first().click();
  await expect(editor.locator('.cm-foldPlaceholder')).toHaveCount(1);
  await open(page, 'note.md');
  await page.getByRole('tab', { name: 'code.ts', exact: true }).click();
  await expect(editor.locator('.cm-foldPlaceholder')).toHaveCount(1);
  await panel(page).getByRole('button', { name: '放大代码', exact: true }).click();
  await page.reload();
  await expect(panel(page).locator('.cm-editor')).toHaveCSS('font-size', '15px');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
});

test('Obsidian heading links open the target file at its heading', async ({ page }) => {
  await page.goto(`/#notes/${libraryId}?file=note.md`);
  await expect(panel(page).locator('.markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
  );
  await panel(page).getByRole('link', { name: '跳到章节' }).click();
  await expect(page.getByRole('tab', { name: 'other.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(() =>
      panel(page)
        .locator('article')
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(600);
  await expect(panel(page).getByRole('heading', { name: 'Target', exact: true })).toBeInViewport();
});

test('reimporting a matching ZIP updates the existing project and its open tab', async ({
  page,
}) => {
  await page.goto(`/#notes/${libraryId}?file=note.md`);
  await expect(panel(page).locator('.markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
  );
  await page.evaluate(() => {
    location.hash = 'notes';
  });
  await page.getByRole('button', { name: '导入笔记', exact: true }).click();
  await page.getByLabel('选择 ZIP 文件').setInputFiles({
    name: 'reader-fixes.zip',
    mimeType: 'application/zip',
    buffer: archive({ 'note.md': '# Updated in place', 'new.md': 'New' }),
  });
  await expect(page.getByRole('button', { name: '更新项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更新项目', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(libraryId));
  await expect(panel(page).getByRole('heading', { name: 'Updated in place' })).toBeVisible();
  const libraries = (await (await page.request.get('/api/libraries')).json()).libraries;
  expect(libraries.filter((library: any) => library.name === 'reader-fixes')).toHaveLength(1);
  await expect(page.locator('.reader-tabs [role=tab]').filter({ hasText: 'note.md' })).toHaveCount(
    1,
  );
});

test('ambiguous project names require an explicit update target and preserve the other project', async ({
  page,
}) => {
  const duplicate = await page.request.post('/api/import?kind=notes&name=reader-fixes', {
    headers: { origin },
    multipart: {
      file: {
        name: 'duplicate.zip',
        mimeType: 'application/zip',
        buffer: archive({ 'other.md': '# Other project stays' }),
      },
    },
  });
  expect(duplicate.ok()).toBeTruthy();
  const otherId = (await duplicate.json()).library.id;
  try {
    await page.goto('/#notes');
    await page.getByRole('button', { name: '导入笔记', exact: true }).click();
    await page.getByLabel('选择 ZIP 文件').setInputFiles({
      name: 'reader-fixes.zip',
      mimeType: 'application/zip',
      buffer: archive({ 'note.md': '# Chosen project updated' }),
    });
    await expect(page.getByRole('alert')).toContainText('存在多个同名项目');
    await expect(page.getByRole('button', { name: '导入并开始阅读' })).toBeDisabled();
    await page.getByLabel('导入目标').selectOption(libraryId);
    await page.getByRole('button', { name: '更新项目', exact: true }).click();
    await expect(
      panel(page).getByRole('heading', { name: 'Chosen project updated' }),
    ).toBeVisible();
    const original = await page.request.get(`/api/libraries/${otherId}/file?path=other.md`);
    expect(await original.text()).toBe('# Other project stays');
  } finally {
    await page.request.delete(`/api/libraries/${otherId}`, { headers: { origin } });
  }
});

test('compact reader gives content the viewport and focus mode preserves the current editor', async ({
  page,
  isMobile,
}) => {
  if (isMobile) await page.setViewportSize({ width: 373, height: 755 });
  await page.goto(`/#notes/${libraryId}?file=code.ts`);
  const editor = panel(page).locator('.cm-editor');
  await expect(editor).toBeVisible();
  const heightRatio = () =>
    editor.evaluate((element) => element.getBoundingClientRect().height / innerHeight);
  if (isMobile) {
    await expect(page.getByRole('tablist', { name: '已打开的文件' })).toHaveCount(0);
    await expect.poll(heightRatio).toBeGreaterThan(0.86);
    await (await readerControl(page, '自动换行')).click();
    await page.getByRole('button', { name: '阅读工具', exact: true }).click();
    await expect(page.getByRole('region', { name: '阅读工具' })).toHaveCount(0);
    const currentFile = page.url();
    await page.getByRole('button', { name: '阅读工具', exact: true }).click();
    await page.goBack();
    await expect(page.getByRole('region', { name: '阅读工具' })).toHaveCount(0);
    expect(page.url()).toBe(currentFile);
    await page.getByRole('button', { name: '阅读工具', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: '阅读工具' })).toHaveCount(0);
  }
  await editor.evaluate((element) => {
    (window as any).focusedEditor = element;
    element.querySelector('.cm-scroller')!.scrollTop = 700;
  });
  await expect
    .poll(() => editor.locator('.cm-scroller').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(650);
  if (isMobile) await page.getByRole('button', { name: '阅读工具', exact: true }).click();
  await page.getByRole('button', { name: '专注阅读', exact: true }).click();
  await expect(page.getByRole('region', { name: '阅读工具' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '退出专注阅读' })).toBeVisible();
  await expect.poll(heightRatio).toBeGreaterThan(0.98);
  expect(
    await editor.evaluate((element) => element === (window as any).focusedEditor),
  ).toBeTruthy();
  await expect(editor.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '退出专注阅读' })).toHaveCount(0);
  expect(
    await editor.evaluate((element) => element === (window as any).focusedEditor),
  ).toBeTruthy();
  await expect
    .poll(() => editor.locator('.cm-scroller').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(650);
  await open(page, 'note.md');
  await expect(panel(page).locator('.markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
  );
  await expect(page.getByRole('tab', { name: 'code.ts', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '专注阅读', exact: true }).click();
  await expect(panel(page).getByRole('navigation', { name: '阅读操作' })).toBeHidden();
  await page.getByRole('button', { name: '退出专注阅读' }).click();
  await expect(panel(page).getByRole('navigation', { name: '阅读操作' })).toBeVisible();
  await page.getByRole('tab', { name: 'code.ts', exact: true }).click();
  if (isMobile) await expect.poll(heightRatio).toBeGreaterThan(0.8);
});
