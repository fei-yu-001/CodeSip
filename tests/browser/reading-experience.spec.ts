import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
async function syncNow(page: Page) {
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await page.getByRole('button', { name: '同步', exact: true }).click();
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
const source =
  '# 阅读体验\n\n选择这段文字记录想法。\n\n' +
  Array.from(
    { length: 32 },
    (_, i) => `## 章节 ${i + 1}\n\n${'长文阅读段落，按钮应该一直可用。'.repeat(16)}`,
  ).join('\n\n');
async function open(page: Page) {
  const response = await page.request.post('/api/import?kind=notes&name=reading-experience', {
    headers: { origin },
    multipart: {
      file: {
        name: 'reading.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(zipSync({ 'note.md': strToU8(source) })),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const lib = (await response.json()).library;
  await page.goto(`/#notes/${lib.id}?file=note.md`);
  await expect(page.locator('.markdown-content')).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑文档', exact: true })).toBeEnabled();
  return lib;
}
async function copy(page: Page, id: string) {
  return (await (await page.request.get(`/api/libraries/${id}/document-copy?path=note.md`)).json())
    .copy;
}

test('reader actions remain reachable in long documents, selected text is annotated and list edits are available', async ({
  page,
}, info) => {
  await open(page);
  await expect(page.locator('.reader-controls-bar')).toHaveCount(0);
  await page
    .locator('.markdown-content p')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
  await expect(page.getByRole('button', { name: '添加笔记批注' })).toContainText('选段批注');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
    '选择这段文字记录想法',
  );
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await expect(page.locator('.drawer-snippet')).toContainText('选择这段文字记录想法');
  await page.getByRole('textbox', { name: '批注内容' }).fill('选段批注测试');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await page.locator('article.markdown').evaluate((element) => {
    element.scrollTop = 5000;
  });
  await expect
    .poll(() => page.locator('article.markdown').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(4900);
  await expect(page.getByRole('button', { name: '添加笔记批注' })).toBeInViewport();
  await expect(page.getByRole('button', { name: '阅读设置', exact: true })).toBeInViewport();
  const geometry = await page.locator('article.markdown').evaluate((element) => ({
    article: element.getBoundingClientRect().bottom,
    actions: document.querySelector('.reading-actions')!.getBoundingClientRect().top,
  }));
  expect(geometry.article).toBeLessThanOrEqual(geometry.actions + 1);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-reading-actions.png` });
  await page.getByRole('button', { name: '查看批注列表' }).click();
  await page
    .getByRole('dialog', { name: '批注列表' })
    .getByRole('button', { name: /选段批注测试/ })
    .click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('从底部列表修改批注');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await page.getByRole('button', { name: '查看批注列表' }).click();
  await expect(page.getByRole('dialog', { name: '批注列表' })).toContainText('从底部列表修改批注');
  await page
    .getByRole('dialog', { name: '批注列表' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByRole('button', { name: '增大字号' }).click();
  await page.getByRole('button', { name: '紧凑', exact: true }).click();
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-reading-settings.png` });
  await page.reload();
  await expect(page.locator('article.markdown')).toHaveCSS('font-size', '18px');
  await expect(page.locator('article.markdown')).toHaveCSS('line-height', '29.7px');
  await expect(page.locator('.avatar-mini img')).toHaveAttribute('src', '/qiqi-avatar.jpg');
  expect(
    await page.locator('.avatar-mini img').evaluate((el) => (el as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
});

test('edited documents restore local drafts, save independent copies and leave synced originals untouched', async ({
  page,
}, info) => {
  const lib = await open(page);
  const manifest = await (await page.request.get(`/api/libraries/${lib.id}/manifest`)).json();
  await page.getByRole('button', { name: '编辑文档', exact: true }).click();
  const input = page.getByRole('textbox', { name: '文档内容' });
  await input.fill('# 我的编辑版\n\n手机补充的理解。');
  await expect(page.getByRole('status').filter({ hasText: '编辑版已存本机' })).toBeVisible();
  expect(
    await page.evaluate(
      () => !window.dispatchEvent(new Event('codesip:before-update', { cancelable: true })),
    ),
  ).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-document-editor.png` });
  await page.reload();
  await expect(page.locator('.markdown-content')).toContainText('手机补充的理解');
  await expect(page.locator('.reading-copy-status')).toContainText('本机草稿');
  expect(await copy(page, lib.id)).toBeNull();
  await page.getByRole('button', { name: '编辑文档', exact: true }).click();
  await expect(input).toHaveValue('# 我的编辑版\n\n手机补充的理解。');
  await page.getByRole('button', { name: '保存编辑版', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '编辑文档', exact: true })).toHaveCount(0);
  expect(await copy(page, lib.id)).toBeNull();
  await syncNow(page);
  expect((await copy(page, lib.id)).content).toContain('手机补充的理解');
  expect(await (await page.request.get(`/api/libraries/${lib.id}/manifest`)).json()).toEqual(
    manifest,
  );
  expect(
    await (
      await page.request.get(
        `/api/libraries/${lib.id}/file?path=note.md&hash=${manifest.files[0].hash}`,
      )
    ).text(),
  ).toBe(source);
  await page.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(page.locator('.markdown-content')).toContainText('选择这段文字记录想法');
  await page.getByRole('button', { name: '查看我的编辑版', exact: true }).click();
  await expect(page.locator('.markdown-content')).toContainText('手机补充的理解');
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(new Event('codesip:before-update', { cancelable: true })),
    ),
  ).toBe(true);
});

test('offline document drafts survive reopening and retry after reconnect', async ({
  page,
  context,
}) => {
  const lib = await open(page);
  await page.getByRole('button', { name: '保存离线', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存离线', exact: true })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.getByRole('button', { name: '编辑文档', exact: true }).click();
  await page.getByRole('textbox', { name: '文档内容' }).fill('# 离线编辑草稿');
  await page.getByRole('button', { name: '保存编辑版', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '编辑文档', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await page.reload();
  await expect(page.locator('.markdown-content')).toContainText('离线编辑草稿');
  await context.setOffline(false);
  expect(await copy(page, lib.id)).toBeNull();
  await syncNow(page);
  await expect.poll(async () => (await copy(page, lib.id))?.content).toBe('# 离线编辑草稿');
});

test('conflicting document writes preserve both versions until explicitly resolved', async ({
  page,
}) => {
  const lib = await open(page);
  const manifest = await (await page.request.get(`/api/libraries/${lib.id}/manifest`)).json();
  await page.getByRole('button', { name: '编辑文档', exact: true }).click();
  await page.getByRole('textbox', { name: '文档内容' }).fill('# 本机正在写的版本');
  const remote = await page.request.put(`/api/libraries/${lib.id}/document-copy`, {
    headers: { origin },
    data: {
      path: 'note.md',
      content: '# 其他设备的版本',
      baseHash: manifest.files[0].hash,
      expectedUpdatedAt: null,
    },
  });
  expect(remote.ok()).toBeTruthy();
  await page.getByRole('button', { name: '保存编辑版', exact: true }).click();
  await syncNow(page);
  await page.getByRole('button', { name: '编辑文档', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('其他设备已修改');
  await expect(page.getByRole('textbox', { name: '文档内容' })).toHaveValue('# 本机正在写的版本');
  expect((await copy(page, lib.id)).content).toBe('# 其他设备的版本');
  await page.getByText('查看云端版本', { exact: true }).click();
  await expect(page.locator('.document-conflict pre')).toHaveText('# 其他设备的版本');
  await page.getByRole('button', { name: '保留我的编辑', exact: true }).click();
  await expect(page.locator('.document-editor-status')).toContainText('编辑版已同步');
  expect((await copy(page, lib.id)).content).toBe('# 本机正在写的版本');
  await page.getByRole('textbox', { name: '文档内容' }).fill('# 第二次本机修改');
  const latest = await copy(page, lib.id);
  await page.request.put(`/api/libraries/${lib.id}/document-copy`, {
    headers: { origin },
    data: {
      path: 'note.md',
      content: '# 保留云端的版本',
      baseHash: manifest.files[0].hash,
      expectedUpdatedAt: latest.updatedAt,
    },
  });
  await page.getByRole('button', { name: '保存编辑版', exact: true }).click();
  await syncNow(page);
  await page.getByRole('button', { name: '编辑文档', exact: true }).click();
  await page.getByRole('button', { name: '采用云端版本', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档内容' })).toHaveValue('# 保留云端的版本');
});

test('storage failure keeps the document editor open and expired sessions preserve drafts until explicit logout', async ({
  page,
  context,
}) => {
  const lib = await open(page);
  await page.getByRole('button', { name: '编辑文档', exact: true }).click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).restoreDocumentStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('codesip:document:'))
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await page.getByRole('textbox', { name: '文档内容' }).fill('# 空间不足不能丢失');
  await expect(page.getByRole('alert')).toContainText('本机空间不足');
  await page.getByRole('button', { name: '返回阅读', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档内容' })).toHaveValue('# 空间不足不能丢失');
  await page.evaluate(() => (window as any).restoreDocumentStorage());
  await page.getByRole('textbox', { name: '文档内容' }).fill('# 登录过期后仍保留的文档草稿');
  await expect(page.locator('.document-editor-status')).toContainText('编辑版已存本机');
  await page.getByRole('button', { name: '返回阅读', exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(new Event('codesip:before-update', { cancelable: true })),
    ),
  ).toBe(true);
  await context.clearCookies();
  await page.reload();
  await expect(page.locator('.markdown-content')).toBeVisible();
  await syncNow(page);
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  const drafts = () =>
    page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('codesip:document:')),
    );
  expect((await drafts()).length).toBeGreaterThan(0);
  await page.getByLabel('账号', { exact: true }).fill('browser');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '进入 CodeSip', exact: true }).click();
  await expect(page.getByRole('button', { name: '账号与退出' })).toBeVisible();
  await page.goto(`/#notes/${lib.id}?file=note.md`);
  await expect(page.locator('.markdown-content')).toContainText('登录过期后仍保留的文档草稿');
  await page.getByRole('button', { name: '账号与退出' }).click();
  await expect(page.locator('.avatar-large img')).toHaveAttribute('src', '/qiqi-avatar.jpg');
  await page
    .getByRole('dialog', { name: '当前账号' })
    .getByRole('button', { name: '退出登录' })
    .click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  expect(await drafts()).toEqual([]);
});
