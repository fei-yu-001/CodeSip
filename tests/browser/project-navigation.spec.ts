import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import type { Library, Manifest, User } from '../../shared/types';

const headers = { origin: 'http://127.0.0.1:4319' };
let created: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of created) await page.request.delete(`/api/libraries/${id}`, { headers });
  created = [];
});

async function createProject(page: Page, label: string) {
  const status = await page.request.get('/api/status');
  const needsSetup = (await status.json()).needsSetup;
  const login = await page.request.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    headers,
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(needsSetup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  expect(login.ok()).toBeTruthy();
  const { user } = (await login.json()) as { user: User };
  const imported = await page.request.post(
    `/api/import?name=${encodeURIComponent(label)}&kind=code`,
    {
      headers,
      multipart: {
        file: {
          name: 'synthetic-navigation.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from(zipSync({ 'README.md': strToU8('# Navigation fixture') })),
        },
      },
    },
  );
  expect(imported.ok()).toBeTruthy();
  const { library } = (await imported.json()) as { library: Library };
  created.push(library.id);
  return { user, library };
}

async function readManifestCache(page: Page, userId: string, libraryId: string) {
  return page.evaluate(
    async ({ userId, libraryId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('codesip-reader', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<Manifest | undefined>((resolve, reject) => {
          const request = database
            .transaction('cache', 'readonly')
            .objectStore('cache')
            .get(`${userId}:manifest:${libraryId}`);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    },
    { userId, libraryId },
  );
}

test('opens a leading-slash project hash using the intended project id', async ({ page }, info) => {
  const { library } = await createProject(page, `slash-navigation-${info.project.name}`);
  const requestedIds: string[] = [];
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(/^\/api\/libraries\/([^/]+)\/manifest$/);
    if (match) requestedIds.push(match[1]);
  });

  await page.goto(`/#/code/${library.id}?file=README.md`);
  await expect(
    page.getByRole('heading', { name: 'Navigation fixture', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.breadcrumb')).toContainText(library.name);
  expect(requestedIds).toEqual([library.id]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('keeps a cached project readable after its cloud copy is removed', async ({ page }, info) => {
  const { user, library } = await createProject(page, `cached-navigation-${info.project.name}`);
  const url = `/#code/${library.id}?file=README.md`;
  await page.goto(url);
  await expect(
    page.getByRole('heading', { name: 'Navigation fixture', exact: true }),
  ).toBeVisible();
  const savedManifest = await readManifestCache(page, user.id, library.id);
  expect(savedManifest?.library.id).toBe(library.id);

  const removed = await page.request.delete(`/api/libraries/${library.id}`, { headers });
  expect(removed.ok()).toBeTruthy();
  let requests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(`/api/libraries/${library.id}/`)) requests++;
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Navigation fixture', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(requests).toBe(0);
  expect(await readManifestCache(page, user.id, library.id)).toEqual(savedManifest);
});

test('shows a persistent uncached-project 404 and retries the same project', async ({
  page,
}, info) => {
  const { library } = await createProject(page, `missing-navigation-${info.project.name}`);
  const manifestUrl = `**/api/libraries/${library.id}/manifest`;
  await page.route(manifestUrl, (route) =>
    route.fulfill({ status: 404, json: { error: '找不到这个项目' } }),
  );
  await page.goto(`/#code/${library.id}?file=README.md`);
  await expect(page.getByRole('alert')).toContainText('找不到这个项目');
  await expect(page.getByRole('button', { name: '重试打开项目', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '回到项目列表', exact: true })).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(`#code/${library.id}?file=README.md`);

  await page.unroute(manifestUrl);
  await page.getByRole('button', { name: '重试打开项目', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Navigation fixture', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('distinguishes a network failure from an uncached-project 404 and allows returning', async ({
  page,
}, info) => {
  const { library } = await createProject(page, `network-navigation-${info.project.name}`);
  await page.route(`**/api/libraries/${library.id}/manifest`, (route) => route.abort('failed'));
  await page.goto(`/#code/${library.id}?file=README.md`);
  await expect(page.getByRole('alert')).toContainText('无法连接服务器');
  await expect(page.getByRole('alert')).not.toContainText('找不到这个项目');
  expect(await page.evaluate(() => location.hash)).toBe(`#code/${library.id}?file=README.md`);

  await page.getByRole('button', { name: '回到项目列表', exact: true }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#code');
  await expect(page.getByRole('heading', { name: '代码项目', exact: true })).toBeVisible();
});

test('ignores a late failed request after opening a different project', async ({ page }, info) => {
  const first = await createProject(page, `slow-navigation-${info.project.name}`);
  const second = await createProject(page, `new-navigation-${info.project.name}`);
  let release: (() => void) | undefined;
  await page.route(`**/api/libraries/${first.library.id}/manifest`, async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ status: 404, json: { error: '找不到这个项目' } });
  });
  try {
    await page.goto(`/#code/${first.library.id}?file=README.md`);
    await expect.poll(() => !!release).toBe(true);
    await page.evaluate((id) => {
      location.hash = `code/${id}?file=README.md`;
    }, second.library.id);
    await expect(page.locator('.breadcrumb')).toContainText(second.library.name);
    await expect(
      page.getByRole('heading', { name: 'Navigation fixture', exact: true }),
    ).toBeVisible();
    const lateResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/libraries/${first.library.id}/manifest`),
    );
    release!();
    await lateResponse;
    await expect(page.locator('.breadcrumb')).toContainText(second.library.name);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await readManifestCache(page, second.user.id, second.library.id))?.library.id).toBe(
      second.library.id,
    );
  } finally {
    release?.();
  }
});
