import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
const origin = 'http://127.0.0.1:4319';
let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
let baseVersion: string;
const updatedVersion = '123456789abc';
const versionOf = (page: Page) =>
  page.locator('meta[name="codesip-version"]').getAttribute('content');
const check = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('codesip:check-update')));

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: origin });
  const setup = (await (await request.get('/api/status')).json()).needsSetup;
  const result = await request.post(setup ? '/api/auth/setup' : '/api/auth/login', {
    headers: { origin },
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(setup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  expect(result.ok()).toBeTruthy();
  cookies = (await request.storageState()).cookies;
  await request.dispose();
});
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(cookies);
  baseVersion = (
    await (
      await page.request.post('/__test/update-control', { headers: { origin }, data: {} })
    ).json()
  ).baseVersion;
  await page.goto('/');
  await expect(page.getByRole('button', { name: '账号与退出' })).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/update-control', { headers: { origin }, data: {} });
});

async function publish(page: Page, options: { failure?: string; slow?: boolean } = {}) {
  const result = await page.request.post('/__test/update-control', {
    headers: { origin },
    data: { version: updatedVersion, ...options },
  });
  expect(result.ok()).toBeTruthy();
  await check(page);
}
async function note(page: Page) {
  const response = await page.request.post('/api/import?kind=notes&name=update-fixture', {
    headers: { origin },
    multipart: {
      file: {
        name: 'update.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync({
            'note.md': strToU8(
              '# 更新检查\n\n' + '这是一段用于验证阅读位置的合成文字。\n\n'.repeat(180),
            ),
          }),
        ),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const lib = (await response.json()).library;
  await page.goto(`/#notes/${lib.id}?file=note.md`);
  await expect(page.locator('.markdown-content')).toBeVisible();
  return lib;
}

test('first installation is quiet; account checks updates and back dismisses the dialog', async ({
  page,
}) => {
  await expect(page.locator('.update-chip')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '账号与退出' }).click();
  await page.getByRole('button', { name: '检查应用更新', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '已是最新版本' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '账号与退出' })).toBeVisible();
  expect(await versionOf(page)).toBe(baseVersion);
});

test('real download progress can be deferred; reload preserves offline drafts and reading position', async ({
  page,
  context,
}, testInfo) => {
  await note(page);
  await page.getByRole('button', { name: '保存离线', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存离线', exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('更新后必须保留的离线草稿');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(page.locator('.annotation-pill.status-pending')).toBeVisible();
  const drafts = await page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage).filter(([key]) => key.startsWith('codesip:annotations:v2:')),
    ),
  );
  await context.setOffline(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.annotation-pill.status-pending')).toBeVisible();
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await expect(page.locator('.annotation-pill.status-synced')).toBeVisible();
  await expect(page.getByRole('button', { name: '正在同步', exact: true })).toHaveCount(0);
  await page.locator('article.markdown').evaluate((el) => {
    el.scrollTop = 1400;
  });
  await expect
    .poll(() => page.locator('article.markdown').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1300);
  const before = await page.evaluate(() => ({
    start: performance.timeOrigin,
    hash: location.hash,
  }));
  await publish(page, { slow: true });
  await expect(page.getByRole('dialog', { name: '发现新版' })).toBeVisible();
  const progress = page.getByRole('progressbar', { name: '更新下载进度' });
  await expect.poll(async () => Number(await progress.getAttribute('value'))).toBeGreaterThan(0);
  expect(Number(await progress.getAttribute('value'))).toBeLessThan(100);
  if (testInfo.project.name === 'mobile')
    await page.screenshot({ path: '.local/screenshots/update-downloading-mobile.png' });
  await page.getByRole('button', { name: '稍后处理' }).click();
  await expect(page.getByRole('button', { name: '新版已就绪', exact: true })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before.start);
  expect(await versionOf(page)).toBe(baseVersion);
  await page.getByRole('button', { name: '新版已就绪', exact: true }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100');
  if (testInfo.project.name === 'mobile')
    await page.screenshot({ path: '.local/screenshots/update-ready-mobile.png' });
  await context.setOffline(true);
  // Restore a synthetic pending record immediately before reload, with networking disabled.
  await page.evaluate((values) => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  }, drafts);
  // Reopening offline must still offer the already downloaded update.
  await page.reload();
  expect(await versionOf(page)).toBe(baseVersion);
  await expect(page.getByRole('dialog', { name: '新版已准备好' })).toBeVisible();
  await page.getByRole('button', { name: '重载更新', exact: true }).click();
  await expect.poll(() => versionOf(page)).toBe(updatedVersion);
  await expect(page.locator('.markdown-content')).toBeVisible();
  await expect(page.locator('.annotation-pill')).toContainText('更新后必须保留的离线草稿');
  await expect
    .poll(() => page.locator('article.markdown').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1300);
  expect(await page.evaluate(() => location.hash)).toBe(before.hash);
  await expect(page.getByRole('status').filter({ hasText: '应用已更新' })).toBeVisible();
});

test('corrupt download retains old offline shell and retries successfully', async ({
  page,
  context,
}) => {
  await publish(page, { failure: 'corrupt' });
  await expect(page.getByRole('dialog', { name: '更新暂未完成' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('仍可使用当前版本');
  expect(await page.evaluate(() => caches.keys())).toContain(`codesip-shell-${baseVersion}`);
  expect(await page.evaluate(() => caches.keys())).not.toContain(`codesip-shell-${updatedVersion}`);
  await context.setOffline(true);
  await page.reload();
  expect(await versionOf(page)).toBe(baseVersion);
  await expect(page.getByRole('button', { name: '账号与退出' })).toBeVisible();
  await check(page);
  await expect(page.getByRole('dialog', { name: '更新暂未完成' })).toBeVisible();
  await page.request.post('/__test/update-control', {
    headers: { origin },
    data: { version: updatedVersion },
  });
  await context.setOffline(false);
  await page.getByRole('button', { name: '重试更新' }).click();
  await expect(page.getByRole('dialog', { name: '新版已准备好' })).toBeVisible();
  await page.getByRole('button', { name: '重载更新', exact: true }).click();
  await expect.poll(() => versionOf(page)).toBe(updatedVersion);
});

test('unsaved editor blocks reload and another tab never reloads without confirmation', async ({
  page,
  context,
}) => {
  await note(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.waitForFunction(() => !!navigator.serviceWorker.controller);
  const otherStart = await other.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: '添加笔记批注' }).click();
  await page.getByRole('textbox', { name: '批注内容' }).fill('仍在编辑，还未保存');
  await page.request.post('/__test/update-control', {
    headers: { origin },
    data: { version: updatedVersion },
  });
  // Automatic checks do not cover the open editor with a dialog.
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect(page.getByRole('button', { name: '新版已就绪', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '新版已准备好' })).toHaveCount(0);
  await page.getByRole('button', { name: '新版已就绪', exact: true }).click();
  await page.getByRole('button', { name: '重载更新', exact: true }).click();
  await expect(page.locator('.update-message')).toContainText('请先保存或关闭正在编辑的批注');
  expect(await versionOf(page)).toBe(baseVersion);
  await page.getByRole('button', { name: '稍后处理' }).click();
  await expect(page.getByRole('textbox', { name: '批注内容' })).toHaveValue('仍在编辑，还未保存');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await page.getByRole('button', { name: '新版已就绪', exact: true }).click();
  await page.getByRole('button', { name: '重载更新', exact: true }).click();
  await expect.poll(() => versionOf(page)).toBe(updatedVersion);
  expect(await other.evaluate(() => performance.timeOrigin)).toBe(otherStart);
  expect(await versionOf(other)).toBe(baseVersion);
  expect(await other.evaluate(() => caches.keys())).toContain(`codesip-shell-${baseVersion}`);
  await check(other);
  await expect(other.getByRole('dialog', { name: '新版已准备好' })).toBeVisible();
  await other.getByRole('button', { name: '重载更新', exact: true }).click();
  await expect.poll(() => versionOf(other)).toBe(updatedVersion);
});

test('legacy network-first reader adopts the updater without an unnecessary second reload', async ({
  page,
}) => {
  await page.request.post('/__test/update-control', {
    headers: { origin },
    data: { legacy: true },
  });
  await page.evaluate(async () => {
    const changed = new Promise<void>((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }),
    );
    await (await navigator.serviceWorker.getRegistration())!.update();
    await changed;
  });
  expect(await page.evaluate(() => caches.keys())).toContain('codesip-shell-legacy-fixture');
  await page.request.post('/__test/update-control', {
    headers: { origin },
    data: { version: updatedVersion },
  });
  await page.reload();
  const startedAt = await page.evaluate(() => performance.timeOrigin);
  await page.waitForFunction(async (version) => {
    const registration = await navigator.serviceWorker.getRegistration();
    return (
      !registration?.installing &&
      !registration?.waiting &&
      (await caches.keys()).includes(`codesip-shell-${version}`)
    );
  }, updatedVersion);
  expect(await versionOf(page)).toBe(updatedVersion);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(startedAt);
  await expect(page.locator('.update-chip')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await check(page);
  await expect(page.getByRole('dialog', { name: '已是最新版本' })).toBeVisible();
});
