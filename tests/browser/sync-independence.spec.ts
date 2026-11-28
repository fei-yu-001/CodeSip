import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { readerControl, closeReaderTools } from './reader-controls';
import type { Library } from '../../shared/types';
const origin = 'http://127.0.0.1:4319';
const fixtureLibraries = new WeakMap<Page, string[]>();
test.afterEach(async ({ page, playwright }) => {
  const ids = fixtureLibraries.get(page) || [];
  if (!ids.length) return;
  // Use a separate request context so offline/expired-session scenarios can clean up.
  const cleanup = await playwright.request.newContext({ baseURL: origin });
  try {
    const login = await cleanup.post('/api/auth/login', {
      headers: { origin },
      data: { username: 'browser', password: 'browser-test-password' },
    });
    expect(login.ok()).toBeTruthy();
    for (const id of ids) {
      const removed = await cleanup.delete(`/api/libraries/${id}`, { headers: { origin } });
      expect([200, 204, 404]).toContain(removed.status());
    }
  } finally {
    fixtureLibraries.delete(page);
    await cleanup.dispose();
  }
});
async function login(page: Page) {
  const setup = (await (await page.request.get('/api/status')).json()).needsSetup;
  const response = await page.request.post(setup ? '/api/auth/setup' : '/api/auth/login', {
    headers: { origin },
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(setup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
}
async function project(page: Page, name: string): Promise<Library> {
  const response = await page.request.post(
    `/api/import?kind=notes&name=${encodeURIComponent(name)}`,
    {
      headers: { origin },
      multipart: {
        file: {
          name: 'synthetic.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from(zipSync({ 'test.md': strToU8(`# ${name} 旧版\n\n合成正文。`) })),
        },
      },
    },
  );
  expect(response.ok()).toBeTruthy();
  const library = (await response.json()).library as Library;
  fixtureLibraries.set(page, [...(fixtureLibraries.get(page) || []), library.id]);
  await page.goto(`/#notes/${library.id}?file=test.md`);
  await expect(page.getByRole('heading', { name: `${name} 旧版`, exact: true })).toBeVisible();
  return library;
}
async function patch(page: Page, library: Library) {
  const response = await page.request.post(`/api/libraries/${library.id}/sync`, {
    headers: { origin },
    data: {
      baseRevision: library.revision,
      deleted: [],
      upserts: [
        {
          path: 'test.md',
          content: Buffer.from(`# ${library.name} 新版\n\n合成新版。`).toString('base64'),
        },
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
}
async function start(page: Page) {
  await (await readerControl(page, '同步')).click();
  await closeReaderTools(page);
}
async function finished(page: Page) {
  await expect(page.getByRole('button', { name: '取消同步', exact: true })).toHaveCount(0, {
    timeout: 30000,
  });
}
for (const width of [1440, 373, 412]) {
  test(`failed projects remain readable and retry independently at ${width}px`, async ({
    page,
  }, info) => {
    test.skip(
      (info.project.name === 'desktop') !== (width === 1440),
      'one matching device per viewport',
    );
    await page.setViewportSize({ width, height: 960 });
    await login(page);
    const a = await project(page, '合成项目甲'),
      b = await project(page, '合成项目乙');
    await patch(page, a);
    await patch(page, b);
    await page.goto('/#notes');
    await expect(page.locator('.dashboard')).toBeVisible();
    const requested: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/manifest')) requested.push(path);
    });
    const failedPath = `**/api/libraries/${a.id}/file?**`;
    await page.route(failedPath, (route) => route.abort());
    await start(page);
    await finished(page);
    const result = page.getByRole('region', { name: '同步结果' });
    await expect(result).toContainText('1 个项目尚未同步完成');
    await result.getByText('查看未完成项目').click();
    await expect(result).toContainText('合成项目甲 · 文件');
    await page.goto(`/#notes/${b.id}?file=test.md`);
    await expect(page.getByRole('heading', { name: '合成项目乙 新版', exact: true })).toBeVisible();
    await page.goto(`/#notes/${a.id}?file=test.md`);
    await expect(page.getByRole('heading', { name: '合成项目甲 旧版', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '编辑文档', exact: true }).click({ trial: true });
    await page.screenshot({
      path: `.local/decoupling-acceptance-20261128/sync-partial-${width}.png`,
    });
    const before = requested.length;
    await page.unroute(failedPath);
    await result.getByRole('button', { name: '重试未完成项目' }).click();
    await finished(page);
    await expect(page.getByRole('heading', { name: '合成项目甲 新版', exact: true })).toBeVisible();
    await expect(result).toHaveCount(0);
    expect(requested.slice(before)).toEqual([`/api/libraries/${a.id}/manifest`]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
  test(`canceling sync releases update protection and keeps reading available at ${width}px`, async ({
    page,
  }, info) => {
    test.skip(
      (info.project.name === 'desktop') !== (width === 1440),
      'one matching device per viewport',
    );
    await page.setViewportSize({ width, height: 960 });
    await login(page);
    const library = await project(page, '可取消合成项目');
    const endpoint = `**/api/libraries/${library.id}/manifest`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    await page.route(endpoint, async (route) => {
      entered = true;
      await gate;
      await route.abort().catch(() => {});
    });
    await start(page);
    await expect.poll(() => entered).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.dispatchEvent(new Event('codesip:before-update', { cancelable: true })),
        ),
      )
      .toBe(false);
    await page.getByRole('button', { name: '取消同步', exact: true }).click();
    release();
    await finished(page);
    await expect(
      page.getByRole('heading', { name: '可取消合成项目 旧版', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.dispatchEvent(new Event('codesip:before-update', { cancelable: true })),
        ),
      )
      .toBe(true);
    await page.unroute(endpoint);
    await start(page);
    await finished(page);
    await expect(page.locator('.toast')).toContainText('同步完成');
  });
}
