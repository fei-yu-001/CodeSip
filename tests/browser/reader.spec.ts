import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
const headers = { origin: 'http://127.0.0.1:4319' };
test('source import, search, note images/links, offline reload and liquid controls', async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const status = await page.request.get('/api/status');
  if ((await status.json()).needsSetup) {
    const result = await page.request.post('/api/auth/setup', {
      headers,
      data: {
        username: 'browser',
        password: 'browser-test-password',
        setupToken: 'browser-test-setup-key',
      },
    });
    expect(result.ok()).toBeTruthy();
  } else
    await page.request.post('/api/auth/login', {
      headers,
      data: { username: 'browser', password: 'browser-test-password' },
    });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '留一点时间，读懂代码。' })).toBeVisible();
  await page.getByRole('button', { name: '导入项目', exact: true }).click();
  const name = '代码测试-' + info.project.name;
  await page.locator('.modal .field input').fill(name);
  const zip = zipSync({
    'demo/src/brew.ts': strToU8('export function brew() {\n  return "coffee";\n}\n'),
    'demo/README.md': strToU8('# Project\nRead the source.'),
  });
  await page
    .getByLabel('选择 ZIP 文件')
    .setInputFiles({ name: 'sample.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await page.getByRole('button', { name: '导入并开始阅读' }).click();
  await expect(page.getByRole('heading', { name: 'Project', exact: true })).toBeVisible();
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开目录' }).click();
  await page.getByRole('button', { name: 'brew.ts', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('export function brew');
  expect(await page.locator('.cm-content').getAttribute('contenteditable')).toBe('false');
  await page.getByRole('button', { name: '搜索项目内容' }).click();
  await page.getByRole('textbox', { name: '项目内全文搜索' }).fill('coffee');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.search-results')).toContainText('第 2 行');
  await page.locator('.search-results>button').click();
  await page.screenshot({
    path: `.local/screenshots/${info.project.name}-code.png`,
    fullPage: true,
  });
  const notes = await page.request.post('/api/libraries', {
    headers,
    data: { name: '学习笔记-' + info.project.name, kind: 'notes' },
  });
  const lib = (await notes.json()).library;
  const token = (
    await (await page.request.post(`/api/libraries/${lib.id}/token`, { headers })).json()
  ).token;
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
  const sync = await page.request.post(`/api/libraries/${lib.id}/sync`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      baseRevision: 0,
      upserts: [
        {
          path: '开始.md',
          content: Buffer.from(
            '# 学习空间\n\n看看 [[下一篇]]\n\n![[photo.png]]\n\n```typescript\nconst learning = true;\n```\n\n<script>window.unsafe=true</script>',
          ).toString('base64'),
        },
        { path: '下一篇.md', content: Buffer.from('# 下一篇\n\n离线也能阅读').toString('base64') },
        { path: 'photo.png', content: png },
      ],
      deleted: [],
    },
  });
  expect(sync.ok()).toBeTruthy();
  await page.goto(`/#notes/${lib.id}?file=${encodeURIComponent('开始.md')}`);
  await expect(page.getByRole('heading', { name: '学习空间' })).toBeVisible();
  await expect(page.locator('.markdown img')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('.hljs-keyword').first()).toBeVisible();
  expect(await page.evaluate(() => Boolean((window as any).unsafe))).toBe(false);
  await page.getByRole('button', { name: '保存离线', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存离线', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '下一篇', exact: true }).click();
  await expect(page.getByRole('heading', { name: '下一篇', exact: true })).toBeVisible();
  await page.screenshot({
    path: `.local/screenshots/${info.project.name}-notes.png`,
    fullPage: true,
  });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '下一篇', exact: true })).toBeVisible();
  await expect(page.getByText('离线也能阅读', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.setOffline(false);
  await page.goto('/#code');
  await expect(page.locator('.library-card').first()).toBeVisible();
  await page.screenshot({
    path: `.local/screenshots/${info.project.name}-home.png`,
    fullPage: true,
  });
  await expect(page.locator('.search-input')).toHaveAttribute('data-optics', 'refraction');
  expect(await page.locator('svg filter feDisplacementMap').count()).toBeGreaterThan(0);
  if (info.project.name === 'mobile') {
    const nav = page.locator('.mobile-nav');
    await expect(nav).toBeVisible();
    expect((await nav.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.button.primary')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toMatch(/0s|0.00001s/);
  expect(errors).toEqual([]);
});

test('late project responses cannot replace the currently selected project', async ({
  page,
}, info) => {
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
  const projects = [];
  for (const label of ['A', 'B']) {
    const response = await page.request.post(
      `/api/import?name=switch-${label}-${info.project.name}&kind=code`,
      {
        headers,
        multipart: {
          file: {
            name: 'project.zip',
            mimeType: 'application/zip',
            buffer: Buffer.from(zipSync({ 'README.md': strToU8(`# Project ${label}`) })),
          },
        },
      },
    );
    expect(response.ok()).toBeTruthy();
    projects.push((await response.json()).library);
  }
  const slowPath = `/api/libraries/${projects[0].id}/manifest`;
  let release!: () => void;
  let requested!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(`**${slowPath}`, async (route) => {
    const response = await route.fetch();
    requested();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/#code/${projects[0].id}?file=README.md`);
    await intercepted;
    await page.evaluate((id) => {
      location.hash = `code/${id}?file=README.md`;
    }, projects[1].id);
    await expect(page.getByRole('heading', { name: 'Project B', exact: true })).toBeVisible();
    const delivered = page.waitForResponse((response) => response.url().endsWith(slowPath));
    release();
    await (await delivered).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await page.locator('.breadcrumb').textContent()).toContain(projects[1].name);
    await expect(page.getByRole('heading', { name: 'Project B', exact: true })).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
