import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
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
async function importNotes(page: Page, files: Record<string, string | Uint8Array>) {
  const response = await page.request.post('/api/import?kind=notes&name=performance-fixture', {
    headers: { origin },
    multipart: {
      file: {
        name: 'notes.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync(
            Object.fromEntries(
              Object.entries(files).map(([name, data]) => [
                name,
                typeof data === 'string' ? strToU8(data) : data,
              ]),
            ),
          ),
        ),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).library.id as string;
}
const longNote =
  '# 长文线程测试\n\n[全局引用][ref]\n\n' +
  Array.from(
    { length: 160 },
    (_, i) =>
      `## 分节 ${i}\n\n这是不会丢失的正文。${'可选择和批注。'.repeat(20)}\n\n\`\`\`ts\n${Array.from({ length: 24 }, (_, n) => `const value${n} = { section: ${i}, text: "hello" };`).join('\n')}\n\`\`\`\n\n`,
  ).join('') +
  '[ref]: https://example.com/target\n';

test('long Markdown streams once, remains interactive and navigates to not-yet-mounted source lines', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).readerParses = 0;
    window.Worker = class extends NativeWorker {
      postMessage(message: any, options?: any) {
        if (message?.type === 'parse') (window as any).readerParses++;
        super.postMessage(message, options);
      }
    };
  });
  const id = await importNotes(page, { 'long.md': longNote, 'small.md': '# 小笔记\n\n独立内容' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/#notes/${id}?file=long.md`);
  await expect(page.getByRole('heading', { name: '长文线程测试', exact: true })).toBeVisible();
  // There is useful content and operable UI before the whole document mounts.
  await expect(page.locator('.reader-panel:not([hidden]) .markdown-content')).toHaveAttribute(
    'data-render-complete',
    'false',
  );
  await page.getByRole('button', { name: '文件大纲', exact: true }).click();
  await expect(page.locator('.outline .heading-item')).toHaveCount(161);
  await page.locator('.outline').getByRole('button', { name: '分节 155', exact: true }).click();
  await expect(page.getByRole('heading', { name: '分节 155', exact: true })).toBeInViewport({
    timeout: 15000,
  });
  await expect(page.locator('.reader-panel:not([hidden]) .markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
    {
      timeout: 15000,
    },
  );
  await expect(page.getByRole('link', { name: '全局引用' })).toHaveAttribute(
    'href',
    'https://example.com/target',
  );
  expect(await page.evaluate(() => (window as any).readerParses)).toBe(1);
  const article = page.locator('.reader-panel:not([hidden]) article.markdown');
  await article.evaluate((element) => {
    element.scrollTop = 18000;
  });
  await page.goto(`/#notes/${id}?file=small.md`);
  await expect(page.getByRole('heading', { name: '小笔记' })).toBeVisible();
  await page.goto(`/#notes/${id}?file=long.md`);
  await expect(page.locator('.reader-panel:not([hidden]) .markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
    {
      timeout: 15000,
    },
  );
  await expect.poll(() => article.evaluate((element) => element.scrollTop)).toBeGreaterThan(17900);
  expect(await page.evaluate(() => (window as any).readerParses)).toBe(2);
  expect(errors).toEqual([]);
});

test('offscreen images wait for the viewport, duplicate images share a verified fetch', async ({
  page,
}) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64',
  );
  const id = await importNotes(page, {
    'images.md':
      '# 按需图片\n\n![near](near.png) ![duplicate](near.png)\n\n' +
      Array.from({ length: 90 }, (_, i) => `## 段 ${i}\n\n${'填充正文。'.repeat(80)}\n\n`).join(
        '',
      ) +
      '![far](far.png)\n',
    'near.png': png,
    'far.png': Buffer.concat([png, Buffer.from('separate-hash')]),
  });
  const requested: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === `/api/libraries/${id}/file` &&
      url.searchParams.get('path')?.endsWith('.png')
    )
      requested.push(url.searchParams.get('path')!);
  });
  await page.goto(`/#notes/${id}?file=images.md`);
  await expect(page.getByRole('img', { name: 'near', exact: true })).toHaveAttribute(
    'src',
    /^blob:/,
  );
  await expect(page.locator('.reader-panel:not([hidden]) .markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
    {
      timeout: 15000,
    },
  );
  expect(requested).toEqual(['near.png']);
  await page.locator('.reader-panel:not([hidden]) article.markdown').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole('img', { name: 'far', exact: true })).toHaveAttribute(
    'src',
    /^blob:/,
  );
  expect(requested).toEqual(['near.png', 'far.png']);
});
