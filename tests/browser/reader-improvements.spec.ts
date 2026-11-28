import { readerControl } from './reader-controls';
import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type APIRequestContext,
} from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

async function syncNow(page: Page) {
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await (await readerControl(page, '同步')).click();
  await expect(page.getByRole('button', { name: '正在同步', exact: true })).toHaveCount(0, {
    timeout: 30000,
  });
}
const origin = 'http://127.0.0.1:4319';
let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: origin });
  const setup = (await (await request.get('/api/status')).json()).needsSetup;
  const response = await request.post(setup ? '/api/auth/setup' : '/api/auth/login', {
    headers: { origin },
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(setup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  cookies = (await request.storageState()).cookies;
  await request.dispose();
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});
async function library(
  request: APIRequestContext,
  kind: 'code' | 'notes',
  files: Record<string, string>,
) {
  const response = await request.post(`/api/import?kind=${kind}&name=reader-${Date.now()}`, {
    headers: { origin },
    multipart: {
      file: {
        name: 'reader.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync(
            Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
          ),
        ),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).library as { id: string; kind: string };
}
async function open(page: Page, lib: { kind: string; id: string }, path: string) {
  await page.goto(`/#${lib.kind}/${lib.id}?file=${encodeURIComponent(path)}`);
  await expect(
    page
      .locator('.reader-panel:not([hidden])')
      .locator(path.endsWith('.md') ? '.markdown-content' : '.cm-content'),
  ).toBeVisible();
}
const longNote =
  '# 阅读检查\n\n第一段用于批注。\n\n' +
  Array.from(
    { length: 45 },
    (_, i) =>
      `## 章节 ${i + 1}\n\n这是用于恢复阅读位置的合成内容。${'段落文字。'.repeat(20)}\n\n\`\`\`ts\nconst value${i} = ${i};\n// # 这是代码，不是标题\n\`\`\``,
  ).join('\n\n');

test('annotations persist offline, edit and delete, and save errors keep the draft', async ({
  page,
  context,
}) => {
  const lib = await library(page.request, 'notes', { 'note.md': '# 批注检查\n\n需要理解的段落。' });
  await open(page, lib, 'note.md');
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('刷新后仍然保留的批注');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(page.locator('.annotation-pill.status-pending')).toContainText('刷新后仍然保留');
  await syncNow(page);
  await expect(page.locator('.annotation-pill.status-synced')).toContainText('刷新后仍然保留');
  await page.reload();
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toContainText(
    '刷新后仍然保留',
  );
  await page.locator('.reader-panel:not([hidden]) .annotation-pill').click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('修改后的批注');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await syncNow(page);
  await expect(page.locator('.annotation-pill.status-synced')).toContainText('修改后的批注');
  await expect(await readerControl(page, '已保存离线')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toContainText(
    '修改后的批注',
  );
  await page.locator('.reader-panel:not([hidden]) .annotation-pill').click();
  await page.getByRole('button', { name: '删除批注', exact: true }).click();
  await expect(page.locator('.annotation-pill.status-deleting')).toContainText('待删除');
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await page.reload();
  await expect(page.locator('.reader-panel:not([hidden]) .markdown-content')).toBeVisible();
  await expect(page.locator('.annotation-pill.status-deleting')).toContainText('修改后的批注');
  await context.setOffline(false);
  await expect(page.locator('.annotation-pill.status-deleting')).toHaveCount(1);
  await syncNow(page);
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/libraries/${lib.id}/annotations?path=note.md`)).json())
      .annotations,
  ).toEqual([]);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('codesip:annotations:v2:'))
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('不能丢失的草稿');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('未能保存');
  await expect(page.getByRole('textbox', { name: '批注内容' })).toHaveValue('不能丢失的草稿');
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toHaveCount(0);
});

test('same-name files isolate annotations and legacy records require explicit import', async ({
  page,
}) => {
  const a = await library(page.request, 'code', { 'shared.ts': 'export const project = "A";' });
  const b = await library(page.request, 'code', { 'shared.ts': 'export const project = "B";' });
  await open(page, a, 'shared.ts');
  await page.getByRole('button', { name: '添加标注', exact: true }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('只属于项目 A');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toContainText(
    '只属于项目 A',
  );
  // Closing a sheet finishes an asynchronous same-URL history traversal.
  // Wait for that transition before issuing an external browser navigation.
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await open(page, b, 'shared.ts');
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toHaveCount(0);
  await page.evaluate(() =>
    localStorage.setItem(
      'codesip:annotations:shared.ts',
      JSON.stringify([
        { id: 'legacy-test', line: 1, snippet: 'legacy', note: '旧版记录', createdAt: 1 },
      ]),
    ),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: '查看旧版批注（1）' })).toBeVisible();
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toHaveCount(0);
  await page.getByRole('button', { name: '查看旧版批注（1）' }).click();
  await page.getByRole('button', { name: '导入此条' }).click();
  await page.getByRole('button', { name: '关闭批注' }).click();
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toContainText(
    '旧版记录',
  );
  expect(
    await page.evaluate(() => localStorage.getItem('codesip:annotations:shared.ts')),
  ).toContain('旧版记录');
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await open(page, a, 'shared.ts');
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toHaveCount(1);
  await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toContainText(
    '只属于项目 A',
  );
});

test('code fills the reader, wrap respects preference and long files remain scrollable', async ({
  page,
}, info) => {
  const lib = await library(page.request, 'code', {
    'short.ts': 'export const short = true;',
    'long.ts': Array.from(
      { length: 160 },
      (_, i) => `export const line${i} = "${'long line '.repeat(22)}";`,
    ).join('\n'),
  });
  await open(page, lib, 'short.ts');
  const body = await page.locator('.document-body').boundingBox();
  const reader = await page.locator('.code-reader-container').boundingBox();
  expect(Math.abs(body!.width - reader!.width)).toBeLessThan(2);
  await (await readerControl(page, '自动换行')).click();
  await expect(page.locator('.reader-panel:not([hidden]) .cm-content')).not.toHaveClass(
    /cm-lineWrapping/,
  );
  await open(page, lib, 'long.ts');
  await expect(page.locator('.reader-panel:not([hidden]) .cm-content')).not.toHaveClass(
    /cm-lineWrapping/,
  );
  expect(
    await page
      .locator('.reader-panel:not([hidden]) .cm-scroller')
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  const scroller = page.locator('.reader-panel:not([hidden]) .cm-scroller');
  await scroller.evaluate((el) => {
    el.scrollTop = 1300;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(1200);
  await page.reload();
  await expect(page.locator('.reader-panel:not([hidden]) .cm-content')).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(1200);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('.reader-panel:not([hidden]) .cm-content')).toContainText('line159');
  const geometry = await scroller.evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    containerBottom: el.closest('.document-body')!.getBoundingClientRect().bottom,
  }));
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.containerBottom + 1);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-reader-fixed-code.png` });
});

test('themes stay synchronized across notes, home and reload', async ({ page }, info) => {
  const lib = await library(page.request, 'notes', {
    'note.md': '# 主题检查\n\n正文\n\n```ts\nconst value = true;\n```',
  });
  await open(page, lib, 'note.md');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByRole('button', { name: '松烟暖灰', exact: false }).last().click();
  await page
    .getByRole('dialog', { name: '阅读设置' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'warm-slate');
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '返回项目列表', exact: true }).click();
  } else {
    await page
      .locator('.breadcrumb')
      .getByRole('button', { name: '学习笔记', exact: true })
      .click();
  }
  await expect(page).toHaveURL(/#notes$/);
  await expect(page.getByRole('heading', { name: '学习笔记', exact: true })).toBeVisible();
  if (info.project.name === 'mobile') {
    await page.locator('.mobile-nav').getByRole('button', { name: '阅读主题' }).click();
    await expect(page.locator('.theme-drawer-item.active')).toContainText('松烟暖灰');
    await page.locator('.theme-drawer-item').filter({ hasText: '羊皮纸棕' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia-parchment');
    await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  }
  await open(page, lib, 'note.md');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page
    .getByRole('dialog', { name: '阅读设置' })
    .getByRole('button', { name: '羊皮纸棕', exact: false })
    .click();
  await page.reload();
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await expect(page.locator('.reader-theme-option[aria-pressed=true]')).toContainText('羊皮纸棕');
  await page
    .getByRole('dialog', { name: '阅读设置' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia-parchment');
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase(),
    ),
  ).toBe('#efe6d5');
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-reader-fixed-theme.png` });
});

test('reading resumes, real headings navigate and explicit searches override saved progress', async ({
  page,
}) => {
  const lib = await library(page.request, 'notes', {
    'long.md':
      longNote + '\n\n```md\n# 假标题\n```\n\n## 重复标题\n\n内容一\n\n## 重复标题\n\n内容二',
    'other.md': '# 另一个文件\n\n内容',
  });
  await open(page, lib, 'long.md');
  const article = page.locator('.reader-panel:not([hidden]) article.markdown');
  await article.evaluate((el) => {
    el.scrollTop = 1250;
  });
  await page.reload();
  await expect(article).toBeVisible();
  await expect.poll(() => article.evaluate((el) => el.scrollTop)).toBeGreaterThan(1200);
  await (await readerControl(page, '文件大纲')).click();
  await expect(page.locator('.outline .heading-item')).toHaveCount(48);
  await expect(page.locator('.outline')).not.toContainText('假标题');
  await page.locator('.outline').getByRole('button', { name: '章节 30', exact: true }).click();
  await expect(page.locator('.outline')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '章节 30', exact: true })).toBeInViewport();
  await (await readerControl(page, '文件大纲')).click();
  await page
    .locator('.outline')
    .getByRole('button', { name: '重复标题', exact: true })
    .nth(1)
    .click();
  await expect(
    page.getByRole('heading', { name: '重复标题', exact: true }).nth(1),
  ).toBeInViewport();
  await page.goto(`/#notes/${lib.id}?file=long.md&line=1`);
  await expect(page.getByRole('heading', { name: '阅读检查', exact: true })).toBeInViewport();
  await open(page, lib, 'other.md');
  expect(await article.evaluate((el) => el.scrollTop)).toBe(0);
});

test('back closes sheets and fullscreen, and code-only mode can be turned off', async ({
  page,
}, info) => {
  const lib = await library(page.request, 'notes', {
    'note.md': '# 返回检查\n\n普通段落\n\n```ts\nconst content = true;\n```',
  });
  await open(page, lib, 'note.md');
  const fileURL = page.url();
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await expect(page.getByRole('dialog', { name: '添加批注', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(page.url()).toBe(fileURL);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByRole('button', { name: '仅看代码', exact: false }).click();
  await expect(page.getByText('普通段落', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByRole('button', { name: '仅看代码', exact: false }).click();
  await expect(page.getByText('普通段落', { exact: true })).toBeVisible();
  await page.getByTitle('全屏沉浸查看', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: '代码全屏阅读' })).toBeVisible();
  expect(
    await page
      .locator('.code-block-card.is-fullscreen')
      .evaluate((el) => el.parentElement === document.body),
  ).toBe(true);
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(page.url()).toBe(fileURL);
  await (await readerControl(page, '文件大纲')).click();
  await page.goBack();
  await expect(page.locator('.outline')).toHaveCount(0);
  expect(page.url()).toBe(fileURL);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '打开目录', exact: true }).click();
    await expect(page.locator('.file-panel')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.tree-scrim')).toHaveCount(0);
    expect(page.url()).toBe(fileURL);
  }
});

test('account dialog and refresh feedback replace window.confirm and provide active states', async ({
  page,
}, info) => {
  const lib = await library(page.request, 'notes', { 'note.md': '# 界面与反馈检查\n\n正文' });
  await open(page, lib, 'note.md');

  // 1. 头像按钮打开应用内弹窗替代 window.confirm
  await (await readerControl(page, '账号与退出')).click();
  const dialog = page.getByRole('dialog', { name: '当前账号' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('browser');
  await dialog.screenshot({ path: `.local/screenshots/${info.project.name}-account-dialog.png` });
  await expect(dialog).toContainText('本机离线副本和未同步草稿会清除，已同步内容保留');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);

  // 2. 桌面阅读保持顶部账号入口，重复打开/关闭不影响阅读
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: '账号与退出', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '当前账号' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '当前账号' })).toHaveCount(0);
  }

  // 3. 刷新按钮具有加载动效并弹出提示
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/libraries', async (route) => {
    await response;
    await route.continue();
  });
  await (await readerControl(page, '同步')).click();
  await expect(page.getByRole('button', { name: '正在同步', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '正在同步', exact: true }).locator('svg'),
  ).toHaveClass(/spin/);
  release();
  await expect(page.locator('.toast')).toContainText('同步完成');
});

test('session expiry keeps user annotation drafts and active logout clears them with explicit warning', async ({
  page,
  context,
}) => {
  const lib = await library(page.request, 'notes', {
    'note.md': '# 草稿防丢检查\n\n需要记录的内容',
  });
  // The draft must really be unsynced; a server copy would hide accidental local deletion.
  await page.route(`**/api/libraries/${lib.id}/annotations/*`, (route) => route.abort('failed'));
  await open(page, lib, 'note.md');
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('自动过期不能丢失的批注草稿');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(page.locator('.annotation-pill.status-pending')).toContainText('自动过期不能丢失');
  expect(
    (await (await page.request.get(`/api/libraries/${lib.id}/annotations?path=note.md`)).json())
      .annotations,
  ).toEqual([]);

  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await context.clearCookies();
  await page.reload();
  await expect(page.locator('.reader-panel:not([hidden]) .markdown-content')).toBeVisible();
  await syncNow(page);
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  const drafts = () =>
    page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('codesip:annotations:v2:')),
    );
  expect((await drafts()).length).toBeGreaterThan(0);
  await page.getByLabel('账号', { exact: true }).fill('browser');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '进入 CodeSip', exact: true }).click();
  await expect(await readerControl(page, '账号与退出')).toBeVisible();
  await open(page, lib, 'note.md');
  await expect(page.locator('.annotation-pill.status-pending')).toContainText('自动过期不能丢失');
  await (await readerControl(page, '账号与退出')).click();
  const dialog = page.getByRole('dialog', { name: '当前账号' });
  await expect(dialog).toContainText('本机离线副本和未同步草稿会清除');
  await dialog.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  expect(await drafts()).toEqual([]);
});

test('server annotations reach a new device, failed saves stay local and open-editor conflicts require a choice', async ({
  page,
  context,
  browser,
}, info) => {
  const lib = await library(page.request, 'notes', {
    'cloud.md': '# 多设备批注\n\n用于验证同步的合成内容。',
  });
  const apiPath = `/api/libraries/${lib.id}/annotations`;
  const writes = `**${apiPath}/*`;
  await page.route(writes, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '测试中的暂时故障' }),
    }),
  );
  await open(page, lib, 'cloud.md');
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('服务失败也不能丢失的草稿');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(page.locator('.annotation-pill.status-pending')).toContainText('服务失败也不能丢失');
  const list = async () =>
    (await (await page.request.get(`${apiPath}?path=cloud.md`)).json()).annotations;
  expect(await list()).toEqual([]);
  const rejectedRetry = page.waitForResponse(
    (response) =>
      response.url().includes(apiPath + '/') &&
      response.request().method() === 'PUT' &&
      response.status() === 503,
  );
  await page.reload();
  await syncNow(page);
  await rejectedRetry;
  await expect(page.locator('.annotation-pill.status-pending')).toContainText('服务失败也不能丢失');
  await page.locator('.reader-panel:not([hidden]) .annotation-pill').click();
  await expect(page.getByRole('button', { name: '立即重试同步' })).toBeVisible();
  await page.unroute(writes);
  await page.getByRole('button', { name: '立即重试同步' }).click();
  await expect(page.locator('.annotation-pill.status-synced')).toContainText('已同步');
  await page.getByRole('button', { name: '关闭批注' }).click();
  expect(await list()).toHaveLength(1);

  const device = await browser.newContext({ baseURL: origin });
  await device.addCookies(await context.cookies());
  const otherPage = await device.newPage();
  try {
    await open(otherPage, lib, 'cloud.md');
    await expect(otherPage.locator('.annotation-pill.status-synced')).toContainText(
      '服务失败也不能丢失',
    );
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    await page.route(`**/api/libraries/${lib.id}/reader-state`, async (route) => {
      await snapshotGate;
      await route.continue();
    });
    await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
    await (await readerControl(page, '同步')).click();
    await page.locator('.reader-panel:not([hidden]) .annotation-pill').click();
    await page.getByRole('textbox', { name: '批注内容' }).fill('编辑器里尚未提交的本机草稿');
    const existing = (await list())[0];
    const update = await device.request.put(`${apiPath}/${existing.id}`, {
      headers: { origin },
      data: {
        path: 'cloud.md',
        line: existing.line,
        snippet: existing.snippet,
        note: '另一台设备的新版本',
        expectedUpdatedAt: existing.updatedAt,
      },
    });
    expect(update.ok()).toBeTruthy();
    releaseSnapshot();
    await expect(page.getByRole('button', { name: '正在同步', exact: true })).toHaveCount(0);
    await page.unroute(`**/api/libraries/${lib.id}/reader-state`);
    await expect(page.locator('.reader-panel:not([hidden]) .annotation-pill')).toContainText(
      '另一台设备的新版本',
    );
    await expect(page.getByRole('textbox', { name: '批注内容' })).toHaveValue(
      '编辑器里尚未提交的本机草稿',
    );
    await page.getByRole('button', { name: '保存批注', exact: true }).click();
    await syncNow(page);
    await expect(page.locator('.annotation-pill.status-conflict')).toContainText('本机草稿');
    expect((await list())[0].note).toBe('另一台设备的新版本');
    await page.reload();
    await expect(page.locator('.annotation-pill.status-conflict')).toContainText('本机草稿');
    await page.locator('.reader-panel:not([hidden]) .annotation-pill').click();
    await expect(page.getByRole('button', { name: '采用服务器版本' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '编辑批注' })).toContainText(
      '批注已在其他设备更新或删除',
    );
    await page
      .getByRole('dialog', { name: '编辑批注' })
      .screenshot({ path: `.local/screenshots/${info.project.name}-annotation-conflict.png` });
    await page.getByRole('button', { name: '保留我的版本' }).click();
    await expect(page.locator('.annotation-pill.status-synced')).toContainText('本机草稿');
    expect((await list())[0].note).toBe('编辑器里尚未提交的本机草稿');
    await otherPage.reload();
    await syncNow(otherPage);
    await expect(otherPage.locator('.annotation-pill.status-synced')).toContainText('本机草稿');
    expect(await list()).toHaveLength(1);
  } finally {
    await device.close();
  }
});
