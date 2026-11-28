import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { readerControl, closeReaderTools } from './reader-controls';
const origin = 'http://127.0.0.1:4319';
let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
let libraries: string[] = [];
let userId = '';
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
  userId = (await response.json()).user.id;
  cookies = (await request.storageState()).cookies;
  await request.dispose();
});
test.beforeEach(async ({ context }) => {
  libraries = [];
  await context.addCookies(cookies);
});
test.afterEach(async ({ page }) => {
  for (const id of libraries)
    await page.request.delete(`/api/libraries/${id}`, { headers: { origin } });
});
async function fixture(
  page: Page,
  files: Record<string, string>,
  kind = 'notes',
  name = 'file-management-fixture',
) {
  const response = await page.request.post(
    `/api/import?kind=${kind}&name=${encodeURIComponent(name)}`,
    {
      headers: { origin },
      multipart: {
        file: {
          name: 'fixture.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from(
            zipSync(
              Object.fromEntries(
                Object.entries(files).map(([path, text]) => [path, strToU8(text)]),
              ),
            ),
          ),
        },
      },
    },
  );
  expect(response.ok()).toBeTruthy();
  const library = (await response.json()).library;
  libraries.push(library.id);
  return library;
}
const panel = (page: Page) => page.locator('.reader-panel:not([hidden])');
async function open(page: Page, id: string, path: string, kind = 'notes') {
  await page.goto(`/#${kind}/${id}?file=${encodeURIComponent(path)}`);
  await expect(panel(page).locator('.markdown-content, .cm-editor')).toBeVisible();
}
async function requestFileDelete(page: Page, path: string) {
  const directory = page.getByRole('button', { name: '打开目录', exact: true });
  if (await directory.isVisible()) await directory.click();
  await page.getByRole('button', { name: `删除文件 ${path}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除文件', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.delete-target')).toContainText(path);
  return dialog;
}
async function keys(page: Page) {
  return page.evaluate(async () => {
    // Use the browser database directly; the production build exposes no test API.
    return await new Promise<string[]>((resolve, reject) => {
      const req = indexedDB.open('codesip-reader', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const read = db.transaction('cache', 'readonly').objectStore('cache').getAllKeys();
        read.onsuccess = () => {
          resolve(read.result.map(String));
          db.close();
        };
        read.onerror = () => {
          reject(read.error);
          db.close();
        };
      };
    });
  });
}

test('file removal requires confirmation, keeps other open files and shared offline bytes, and retries network failure', async ({
  page,
  context,
}, info) => {
  const text = '# Shared note\n\n' + 'Saved reading content.\n\n'.repeat(100);
  const lib = await fixture(page, { 'keep.md': text, '目录/多余 #1.md': text });
  await open(page, lib.id, 'keep.md');
  await (await readerControl(page, '保存离线')).click();
  await expect(await readerControl(page, '已保存离线')).toBeVisible();
  await closeReaderTools(page);
  await panel(page)
    .locator('article.markdown')
    .evaluate((el) => {
      (window as any).keptReader = el;
      el.scrollTop = 500;
    });
  await expect
    .poll(() =>
      panel(page)
        .locator('article.markdown')
        .evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(400);
  await open(page, lib.id, '目录/多余 #1.md');
  let deletes = 0;
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && request.url().includes('/file')) deletes++;
  });
  let dialog = await requestFileDelete(page, '目录/多余 #1.md');
  await expect(dialog).toContainText('再次同步或导入时可能重新出现');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(deletes).toBe(0);
  await expect(page).toHaveURL(/file=.*%231.md/);
  await page.route(`**/api/libraries/${lib.id}/file`, (route) =>
    route.request().method() === 'DELETE' ? route.abort('failed') : route.continue(),
  );
  dialog = await requestFileDelete(page, '目录/多余 #1.md');
  await dialog.getByRole('button', { name: '确认删除文件' }).click();
  await expect(dialog.getByRole('alert')).toContainText('删除未确认');
  expect(
    (await (await page.request.get(`/api/libraries/${lib.id}/manifest`)).json()).files,
  ).toHaveLength(2);
  await page.unroute(`**/api/libraries/${lib.id}/file`);
  await dialog.screenshot({
    path: `.local/file-delete-20261127/${info.project.name}-delete-confirmation.png`,
  });
  await dialog.getByRole('button', { name: '确认删除文件' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/file=keep.md/);
  await expect(page.locator('.reader-tabs [role=tab]')).toHaveCount(1);
  expect(
    await panel(page)
      .locator('article.markdown')
      .evaluate((el) => el === (window as any).keptReader),
  ).toBeTruthy();
  await expect
    .poll(() =>
      panel(page)
        .locator('article.markdown')
        .evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(400);
  await expect(await readerControl(page, '已保存离线')).toBeVisible();
  await closeReaderTools(page);
  expect(
    (await keys(page)).filter((key) => key.startsWith(`${userId}:blob:${lib.id}:`)),
  ).toHaveLength(1);
  await context.setOffline(true);
  await page.reload();
  await expect(panel(page).getByRole('heading', { name: 'Shared note' })).toBeAttached();
  const directory = page.getByRole('button', { name: '打开目录', exact: true });
  if (await directory.isVisible()) await directory.click();
  await expect(
    page.getByRole('button', { name: '删除文件 目录/多余 #1.md', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'keep.md', exact: true })).toBeVisible();
});

test('deleting the last code file leaves an empty project, clears its blob and does not reopen a stale tab', async ({
  page,
  context,
}) => {
  const lib = await fixture(page, { 'main.ts': 'export const value = 1;' }, 'code');
  await open(page, lib.id, 'main.ts', 'code');
  const dialog = await requestFileDelete(page, 'main.ts');
  await dialog.getByRole('button', { name: '确认删除文件' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#code/${lib.id}$`));
  await expect(page.locator('.reader-tabs [role=tab]')).toHaveCount(0);
  await expect(
    page.locator('.reader-empty').getByText('选择文件开始阅读', { exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`/api/libraries/${lib.id}/manifest`)).json()).files,
  ).toEqual([]);
  expect((await keys(page)).filter((key) => key.startsWith(`${userId}:blob:${lib.id}:`))).toEqual(
    [],
  );
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.locator('.reader-empty').getByText('选择文件开始阅读', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
});

test('a changed revision rejects deletion until the reader syncs and confirms again', async ({
  page,
}) => {
  const lib = await fixture(page, { 'note.md': '# Original' });
  await open(page, lib.id, 'note.md');
  const dialog = await requestFileDelete(page, 'note.md');
  const updated = await page.request.post(`/api/libraries/${lib.id}/sync`, {
    headers: { origin },
    data: {
      baseRevision: lib.revision,
      deleted: [],
      upserts: [
        { path: 'note.md', content: Buffer.from('# Updated on computer').toString('base64') },
      ],
    },
  });
  expect(updated.ok()).toBeTruthy();
  await dialog.getByRole('button', { name: '确认删除文件' }).click();
  await expect(dialog.getByRole('alert')).toContainText('项目内容已更新');
  expect((await page.request.get(`/api/libraries/${lib.id}/file?path=note.md`)).status()).toBe(200);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await (await readerControl(page, '同步')).click();
  await expect(page.locator('.toast')).toContainText('同步完成');
  await closeReaderTools(page);
  await expect(panel(page).getByRole('heading', { name: 'Updated on computer' })).toBeVisible();
  await (
    await requestFileDelete(page, 'note.md')
  )
    .getByRole('button', { name: '确认删除文件' })
    .click();
  await expect(page.getByRole('dialog', { name: '删除文件', exact: true })).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/libraries/${lib.id}/manifest`)).json()).files,
  ).toEqual([]);
});

test('home deletion targets one duplicate project, clears its tabs and local drafts and removes empty projects', async ({
  page,
  context,
}, info) => {
  const name = `duplicate-${Date.now()}`;
  const extra = await fixture(page, { 'extra.md': '# Extra project' }, 'notes', name);
  const keep = await fixture(
    page,
    { 'keep.md': '# Keep project', 'second.md': '# Second' },
    'notes',
    name,
  );
  await open(page, extra.id, 'extra.md');
  await open(page, keep.id, 'keep.md');
  const removedKey = `codesip:document:v2:${userId}:${extra.id}:extra.md`;
  const keptKey = `codesip:document:v2:${userId}:${keep.id}:keep.md`;
  await page.evaluate(
    ({ removedKey, keptKey }) => {
      localStorage.setItem(
        removedKey,
        JSON.stringify({
          copy: null,
          draft: {
            content: 'synthetic-local-draft',
            baseHash: '0'.repeat(64),
            expectedUpdatedAt: null,
          },
        }),
      );
      localStorage.setItem(
        keptKey,
        JSON.stringify({
          copy: null,
          draft: {
            content: 'synthetic-kept-draft',
            baseHash: '0'.repeat(64),
            expectedUpdatedAt: null,
          },
        }),
      );
    },
    { removedKey, keptKey },
  );
  await page.goto('/#notes');
  await page.getByRole('textbox', { name: '查找笔记库' }).fill(name);
  const card = page.locator('.library-card-shell').filter({ hasText: '1 个文件' });
  await card.getByRole('button', { name: `删除项目 ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除项目', exact: true });
  await expect(dialog.locator('.delete-target strong')).toHaveText(name);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: `删除项目 ${name}`, exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除项目' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.library-card-shell')).toHaveCount(1);
  await expect(page.locator('.library-card')).toContainText('2 个文件');
  expect((await page.request.get(`/api/libraries/${extra.id}/manifest`)).status()).toBe(404);
  expect((await page.request.get(`/api/libraries/${keep.id}/manifest`)).status()).toBe(200);
  expect(await page.evaluate((key) => localStorage.getItem(key), removedKey)).toBeNull();
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).draft.content, keptKey),
  ).toBe('synthetic-kept-draft');
  await page.evaluate((key) => localStorage.removeItem(key), keptKey);
  expect((await keys(page)).filter((key) => key.includes(extra.id))).toEqual([]);
  await page.locator('.library-card').click();
  await expect(panel(page).getByRole('heading', { name: 'Keep project' })).toBeVisible();
  await expect(page.locator('.reader-tabs [role=tab]')).toHaveCount(1);
  await page.goto('/#notes');
  await page.getByRole('textbox', { name: '查找笔记库' }).fill(name);
  await page.screenshot({
    path: `.local/file-delete-20261127/${info.project.name}-home-delete.png`,
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('textbox', { name: '查找笔记库' }).fill(name);
  await expect(page.locator('.library-card-shell')).toHaveCount(1);
  await context.setOffline(false);
  const empty = await page.request.post('/api/libraries', {
    headers: { origin },
    data: { name: 'empty-delete-fixture', kind: 'notes' },
  });
  const emptyId = (await empty.json()).library.id;
  libraries.push(emptyId);
  await (await readerControl(page, '同步')).click();
  await expect(page.locator('.toast')).toContainText('同步完成');
  await page.getByRole('textbox', { name: '查找笔记库' }).fill('empty-delete-fixture');
  await page.getByRole('button', { name: '删除项目 empty-delete-fixture', exact: true }).click();
  await page.getByRole('button', { name: '确认删除项目', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '删除项目', exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/libraries/${emptyId}/manifest`)).status()).toBe(404);
});
