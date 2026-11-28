import { readerControl, closeReaderTools } from './reader-controls';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
const origin = 'http://127.0.0.1:4319';
let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: origin });
  const setup = (await (await request.get('/api/status')).json()).needsSetup;
  await request.post(setup ? '/api/auth/setup' : '/api/auth/login', {
    headers: { origin },
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(setup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  cookies = (await request.storageState()).cookies;
  await request.dispose();
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});
async function fixture(page: Page) {
  const response = await page.request.post('/api/import?kind=notes&name=local-first-fixture', {
    headers: { origin },
    multipart: {
      file: {
        name: 'local.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync({
            'a.md': strToU8('# 本机 A\n\n已保存的正文。'),
            'b.md': strToU8('# 本机 B\n\n第二篇正文。'),
          }),
        ),
      },
    },
  });
  const library = (await response.json()).library;
  await page.goto(`/#notes/${library.id}?file=a.md`);
  await expect(page.getByRole('heading', { name: '本机 A', exact: true })).toBeVisible();
  return library;
}
async function sync(page: Page) {
  await closeReaderTools(page);
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await (await readerControl(page, '同步')).click();
  await expect(page.getByRole('button', { name: '正在同步', exact: true })).toHaveCount(0, {
    timeout: 30000,
  });
  await closeReaderTools(page);
}

test('cached startup and navigation issue no data requests; edits in a closed document wait for explicit sync', async ({
  page,
  context,
}) => {
  const library = await fixture(page);
  await page.goto(`/#notes/${library.id}?file=b.md`);
  await expect(page.getByRole('heading', { name: '本机 B', exact: true })).toBeVisible();
  await page.goto(`/#notes/${library.id}?file=a.md`);
  await expect(page.getByRole('heading', { name: '本机 A', exact: true })).toBeVisible();
  await sync(page);
  await expect(page.locator('.toast')).toContainText('同步完成');
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('尚未上传的批注');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await page.getByRole('button', { name: '编辑文档', exact: true }).click();
  await page.getByRole('textbox', { name: '文档内容' }).fill('# 本机编辑 A\n\n未上传');
  await page.getByRole('button', { name: '保存编辑版', exact: true }).click();
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  const annotations = async () =>
    (await (await page.request.get(`/api/libraries/${library.id}/annotations?path=a.md`)).json())
      .annotations;
  const copy = async () =>
    (await (await page.request.get(`/api/libraries/${library.id}/document-copy?path=a.md`)).json())
      .copy;
  expect(await annotations()).toEqual([]);
  expect(await copy()).toBeNull();
  const requests: string[] = [];
  await page.route('**/api/**', (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '本机编辑 A', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
  });
  await page.goto(`/#notes/${library.id}?file=b.md`);
  await expect(page.getByRole('heading', { name: '本机 B', exact: true })).toBeVisible();
  await expect.poll(() => requests).toEqual([]);
  await page.waitForTimeout(250);
  expect(requests).toEqual([]);
  await page.unroute('**/api/**');
  expect(await copy()).toBeNull();
  await sync(page);
  expect((await annotations())[0].note).toBe('尚未上传的批注');
  expect((await copy()).content).toContain('本机编辑 A');
  await context.setOffline(true);
  await page.goto(`/#notes/${library.id}?file=a.md`);
  await expect(page.getByRole('heading', { name: '本机编辑 A', exact: true })).toBeVisible();
});

test('interrupted sync retains the saved revision and resumes without overwriting a local draft', async ({
  page,
}) => {
  const library = await fixture(page);
  await (await readerControl(page, '保存离线')).click();
  await expect(await readerControl(page, '已保存离线')).toBeVisible();
  await sync(page);
  const patch = await page.request.post(`/api/libraries/${library.id}/sync`, {
    headers: { origin },
    data: {
      baseRevision: library.revision,
      deleted: [],
      upserts: [
        { path: 'a.md', content: Buffer.from('# 云端新版 A').toString('base64') },
        { path: 'b.md', content: Buffer.from('# 云端新版 B').toString('base64') },
      ],
    },
  });
  expect(patch.ok()).toBeTruthy();
  await page.route(`**/api/libraries/${library.id}/file?**`, (route) =>
    new URL(route.request().url()).searchParams.get('path') === 'b.md'
      ? route.abort()
      : route.continue(),
  );
  await sync(page);
  await expect(page.locator('.toast')).toContainText('同步未完成');
  await page.reload();
  await expect(page.getByRole('heading', { name: '本机 A', exact: true })).toBeVisible();
  await page.goto(`/#notes/${library.id}?file=b.md`);
  await expect(page.getByRole('heading', { name: '本机 B', exact: true })).toBeVisible();
  await page.unroute(`**/api/libraries/${library.id}/file?**`);
  await sync(page);
  await expect(page.getByRole('heading', { name: '云端新版 B', exact: true })).toBeVisible();
});

test('storage quota failure never claims a complete local archive', async ({ page }) => {
  const library = await fixture(page);
  const patch = await page.request.post(`/api/libraries/${library.id}/sync`, {
    headers: { origin },
    data: {
      baseRevision: library.revision,
      deleted: [],
      upserts: [{ path: 'a.md', content: Buffer.from('# 尚未保存的新版 A').toString('base64') }],
    },
  });
  expect(patch.ok()).toBeTruthy();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (typeof key === 'string' && key.includes(':blob:'))
        throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, value, key!);
    };
  });
  await sync(page);
  await expect(page.locator('.toast')).toContainText('同步未完成');
  await expect(await readerControl(page, '已保存离线')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '本机 A', exact: true })).toBeVisible();
  expect(library.id).toBeTruthy();
});

test('explicit reads and sync work when the WebView reports offline but requests succeed', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });
  });
  const library = await fixture(page);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('联网提示不准确时仍可同步');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await page.goto(`/#notes/${library.id}?file=b.md`);
  await expect(page.getByRole('heading', { name: '本机 B', exact: true })).toBeVisible();
  const annotations = async () =>
    (await (await page.request.get(`/api/libraries/${library.id}/annotations?path=a.md`)).json())
      .annotations;
  expect(await annotations()).toEqual([]);
  await sync(page);
  await expect(page.locator('.toast')).toContainText('同步完成');
  expect((await annotations())[0].note).toBe('联网提示不准确时仍可同步');
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
});

test('sync updates saved files without downloading unread files and keeps full archives complete', async ({
  page,
  context,
}) => {
  const library = await fixture(page);
  const patch = await page.request.post(`/api/libraries/${library.id}/sync`, {
    headers: { origin },
    data: {
      baseRevision: library.revision,
      deleted: [],
      upserts: [
        { path: 'a.md', content: Buffer.from('# 已读内容更新').toString('base64') },
        { path: 'c.md', content: Buffer.from('# 新增未读内容').toString('base64') },
      ],
    },
  });
  expect(patch.ok()).toBeTruthy();
  const fetched: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/libraries/${library.id}/file`)
      fetched.push(url.searchParams.get('path')!);
  });
  await sync(page);
  await expect(page.locator('.toast')).toContainText('同步完成');
  await expect(page.getByRole('heading', { name: '已读内容更新', exact: true })).toBeVisible();
  expect(fetched).toEqual(['a.md']);
  await expect(await readerControl(page, '已保存离线')).toHaveCount(0);
  await (await readerControl(page, '保存离线')).click();
  await expect(await readerControl(page, '已保存离线')).toBeVisible();
  const revision = (await (await page.request.get(`/api/libraries/${library.id}/manifest`)).json())
    .library.revision;
  const add = await page.request.post(`/api/libraries/${library.id}/sync`, {
    headers: { origin },
    data: {
      baseRevision: revision,
      deleted: [],
      upserts: [{ path: 'd.md', content: Buffer.from('# 完整离线的新文件').toString('base64') }],
    },
  });
  expect(add.ok()).toBeTruthy();
  fetched.length = 0;
  await sync(page);
  await expect(page.locator('.toast')).toContainText('同步完成');
  expect(fetched).toEqual(['d.md']);
  await expect(await readerControl(page, '已保存离线')).toBeVisible();
  await context.setOffline(true);
  await page.goto(`/#notes/${library.id}?file=d.md`);
  await expect(page.getByRole('heading', { name: '完整离线的新文件', exact: true })).toBeVisible();
});
