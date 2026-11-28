import { test, expect, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:4319';
const updatedVersion = 'abcdef123456';
const chat = (page: Page) => page.getByRole('dialog', { name: '七七', exact: true });
const version = (page: Page) =>
  page.locator('meta[name="codesip-version"]').getAttribute('content');
const canReload = (page: Page) =>
  page.evaluate(() =>
    window.dispatchEvent(new Event('codesip:before-update', { cancelable: true })),
  );

let baseVersion: string;
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
  const reset = await page.request.post('/__test/update-control', {
    headers: { origin },
    data: {},
  });
  baseVersion = (await reset.json()).baseVersion;
  await page.goto('/#notes');
  await expect(page.getByRole('button', { name: '打开七七' })).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/update-control', { headers: { origin }, data: {} });
});

test('closed API settings allow updates while an unsent chat draft remains protected until cleared', async ({
  page,
}) => {
  await expect.poll(() => canReload(page)).toBe(true);
  for (const dismiss of ['button', 'escape', 'back']) {
    await page.getByRole('button', { name: '打开七七' }).click();
    await chat(page).getByRole('button', { name: '七七 API 设置' }).click();
    await chat(page)
      .getByRole('textbox', { name: 'API 地址', exact: true })
      .fill('https://unused.example/v1');
    await expect.poll(() => canReload(page)).toBe(false);
    if (dismiss === 'button') await chat(page).getByRole('button', { name: '关闭七七' }).click();
    else if (dismiss === 'escape') await page.keyboard.press('Escape');
    else await page.goBack();
    await expect(chat(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
    await expect.poll(() => canReload(page)).toBe(true);
  }
  await page.getByRole('button', { name: '打开七七' }).click();
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('更新前还没有发出去的问题');
  await chat(page).getByRole('button', { name: '关闭七七' }).click();
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await expect.poll(() => canReload(page)).toBe(false);
  const publish = await page.request.post('/__test/update-control', {
    headers: { origin },
    data: { version: updatedVersion },
  });
  expect(publish.ok()).toBeTruthy();
  await page.evaluate(() => window.dispatchEvent(new Event('codesip:check-update')));
  await expect(page.getByRole('dialog', { name: '新版已准备好' })).toBeVisible();
  await page.getByRole('button', { name: '重载更新', exact: true }).click();
  await expect(page.locator('.update-message')).toContainText('七七的消息需发送或清空');
  expect(await version(page)).toBe(baseVersion);
  await page.getByRole('button', { name: '稍后处理' }).click();
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await page.getByRole('button', { name: '打开七七' }).click();
  await expect(chat(page).getByRole('textbox', { name: '给七七的消息' })).toHaveValue(
    '更新前还没有发出去的问题',
  );
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('');
  await chat(page).getByRole('button', { name: '关闭七七' }).click();
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await expect.poll(() => canReload(page)).toBe(true);
  await page.getByRole('button', { name: '新版已就绪', exact: true }).click();
  await page.getByRole('button', { name: '重载更新', exact: true }).click();
  await expect.poll(() => version(page)).toBe(updatedVersion);
  await expect(page.getByRole('button', { name: '打开七七' })).toBeVisible();
});
