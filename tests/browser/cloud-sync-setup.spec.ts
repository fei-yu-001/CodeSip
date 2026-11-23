import { test, expect, type BrowserContext } from '@playwright/test';
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
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(cookies);
  await page.goto('/#notes');
  await page.locator('.welcome').getByRole('button', { name: '设置云端同步' }).click();
});

test('cloud setup explains the route without creating anything until requested, then keeps the connection visible', async ({
  page,
}, testInfo) => {
  const dialog = page.getByRole('dialog', { name: '设置云端同步' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('img', { name: '同步路径：电脑 Obsidian → CodeSip 服务端 → 手机阅读' }),
  ).toBeVisible();
  await expect(dialog).toContainText('电脑关机后，已上传的笔记仍可阅读');
  const before = (await (await page.request.get('/api/libraries')).json()).libraries;
  await expect(dialog.getByRole('textbox', { name: 'Obsidian 连接信息' })).toHaveCount(0);
  if (testInfo.project.name === 'mobile')
    await page.screenshot({ path: '.local/screenshots/cloud-sync-setup-mobile.png' });
  await dialog.getByLabel('新笔记库名称').fill('云端同步验证');
  await dialog.getByRole('button', { name: '生成连接信息' }).click();
  const connection = dialog.getByRole('textbox', { name: 'Obsidian 连接信息' });
  await expect(connection).toBeVisible();
  const config = JSON.parse(await connection.inputValue());
  expect(config.server).toBe(origin);
  expect(config.libraryId).toBeTruthy();
  expect(config.token).toMatch(/^csp_/);
  await expect(dialog.locator('.sync-destination')).toHaveText('同步到：云端同步验证');
  const after = (await (await page.request.get('/api/libraries')).json()).libraries;
  expect(after.length).toBe(before.length + 1);
  expect(after.find((lib: { id: string }) => lib.id === config.libraryId).name).toBe(
    '云端同步验证',
  );
  await dialog.getByRole('button', { name: '打开笔记库' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#notes/${config.libraryId}`);
});

test('failed connection generation retries the same new library and an existing library is reused', async ({
  page,
}) => {
  const dialog = page.getByRole('dialog', { name: '设置云端同步' });
  const count = (await (await page.request.get('/api/libraries')).json()).libraries.length;
  let failed = false;
  await page.route('**/api/libraries/*/token', async (route) => {
    if (route.request().method() === 'POST' && !failed) {
      failed = true;
      await route.fulfill({ status: 503, json: { error: '测试：暂时无法生成连接' } });
    } else await route.continue();
  });
  await dialog.getByLabel('新笔记库名称').fill('重试连接验证');
  await dialog.getByRole('button', { name: '生成连接信息' }).click();
  await expect(page.locator('.toast')).toContainText('暂时无法生成连接');
  await expect(dialog.locator('.sync-destination')).toContainText('重试连接验证');
  await dialog.getByRole('button', { name: '生成连接信息' }).click();
  const connection = dialog.getByRole('textbox', { name: 'Obsidian 连接信息' });
  await expect(connection).toBeVisible();
  const config = JSON.parse(await connection.inputValue());
  expect((await (await page.request.get('/api/libraries')).json()).libraries.length).toBe(
    count + 1,
  );
  await dialog.getByRole('button', { name: '打开笔记库' }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('.reader-empty').getByRole('button', { name: '设置云端同步' }).click();
  await expect(dialog.locator('.sync-destination')).toContainText('重试连接验证');
  await expect(dialog.getByLabel('新笔记库名称')).toHaveCount(0);
  await dialog.getByRole('button', { name: '生成连接信息' }).click();
  await expect(connection).toBeVisible();
  expect(JSON.parse(await connection.inputValue()).libraryId).toBe(config.libraryId);
  expect((await (await page.request.get('/api/libraries')).json()).libraries.length).toBe(
    count + 1,
  );
});
