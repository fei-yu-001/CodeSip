import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import type { Library, Manifest } from '../../shared/types';

const origin = 'http://127.0.0.1:4319';
let userId = '';
let ids: string[] = [];
const activeReader = (page: Page) => page.locator('.reader-panel:not([hidden])');
const chat = (page: Page) => page.getByRole('dialog', { name: '七七', exact: true });

test.beforeEach(async ({ page }) => {
  ids = [];
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
  userId = (await response.json()).user.id;
});
test.afterEach(async ({ page }) => {
  for (const id of ids) {
    const response = await page.request.delete('/api/libraries/' + id, { headers: { origin } });
    expect([200, 204, 404]).toContain(response.status());
  }
});
async function fixture(page: Page, heading: string): Promise<Library> {
  const text = '# ' + heading + '\n\nSynthetic reading fixture.\n';
  const response = await page.request.post('/api/import?kind=notes&name=sync-regression', {
    headers: { origin },
    multipart: {
      file: {
        name: 'synthetic.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync({
            'note.md': strToU8(text),
            'intentional-copy.md': strToU8(text),
            'code.ts': strToU8('export const value = 42;\n'),
          }),
        ),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const library = (await response.json()).library as Library;
  ids.push(library.id);
  return library;
}
async function sync(page: Page) {
  const button = page.getByRole('button', { name: '同步', exact: true });
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/libraries'),
    button.click(),
  ]);
  await expect(button).toBeEnabled();
}

for (const width of [373, 412, 1440]) {
  test(
    'reading toolbar opens the same Qiqi chat without a selection at ' + width + 'px',
    async ({ page }, info) => {
      test.skip((width === 1440) !== (info.project.name === 'desktop'));
      await page.setViewportSize({ width, height: 915 });
      const library = await fixture(page, 'Mobile Qiqi entry');
      await page.goto('/#notes/' + library.id + '?file=note.md');
      await expect(
        activeReader(page).getByRole('heading', { name: 'Mobile Qiqi entry' }),
      ).toBeVisible();
      const launcher = page.getByRole('button', { name: '打开七七', exact: true });
      await expect(launcher).toBeVisible();
      await expect(launcher).toContainText('七七');
      await page.screenshot({ path: '.local/mobile-sync-fix-20261128/toolbar-' + width + '.png' });
      await launcher.click();
      await expect(chat(page)).toBeVisible();
      await chat(page)
        .getByRole('textbox', { name: '给七七的消息' })
        .fill('Keep my conversation draft');
      await chat(page).getByRole('button', { name: '关闭七七' }).click();
      await expect(launcher).toBeFocused();
      await page.evaluate((id) => {
        location.hash = '#notes/' + id + '?file=code.ts';
      }, library.id);
      await expect(activeReader(page).locator('.cm-content')).toContainText('export const value');
      await launcher.click();
      await expect(chat(page).getByRole('textbox', { name: '给七七的消息' })).toHaveValue(
        'Keep my conversation draft',
      );
      await expect(page.getByRole('dialog', { name: '七七', exact: true })).toHaveCount(1);
      await chat(page).getByRole('button', { name: '七七 API 设置' }).click();
      await expect(chat(page).getByLabel('API Key', { exact: true })).toBeVisible();
      await expect(chat(page).getByRole('combobox', { name: '模型', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: '.local/mobile-sync-fix-20261128/qiqi-' + width + '.png' });
    },
  );

  test(
    'repeated sync separates an old local archive and never multiplies source files at ' +
      width +
      'px',
    async ({ page, context }, info) => {
      test.skip((width === 1440) !== (info.project.name === 'desktop'));
      await page.setViewportSize({ width, height: 915 });
      const old = await fixture(page, 'Retained local source');
      await page.goto('/#notes/' + old.id + '?file=note.md');
      await expect(
        activeReader(page).getByRole('heading', { name: 'Retained local source' }),
      ).toBeVisible();
      const manifest = (await (
        await page.request.get('/api/libraries/' + old.id + '/manifest')
      ).json()) as Manifest;
      const draftKey = 'codesip:document:v2:' + userId + ':' + old.id + ':note.md';
      const draft = JSON.stringify({
        copy: null,
        draft: {
          content: 'Retain this synthetic draft',
          baseHash: manifest.files.find((file) => file.path === 'note.md')!.hash,
          expectedUpdatedAt: null,
        },
      });
      await page.evaluate(
        ({ draftKey, draft, userId, old }) =>
          new Promise<void>((resolve, reject) => {
            localStorage.setItem(draftKey, draft);
            const request = indexedDB.open('codesip-reader', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const tx = database.transaction('cache', 'readwrite');
              // Reproduce the old duplicate catalog without touching any source bytes.
              tx.objectStore('cache').put(
                [old, old, { ...old, id: 'stale-listing-without-files' }],
                userId + ':libraries',
              );
              tx.oncomplete = () => {
                database.close();
                resolve();
              };
              tx.onerror = () => {
                database.close();
                reject(tx.error);
              };
            };
          }),
        { draftKey, draft, userId, old },
      );
      const current = await fixture(page, 'Current cloud source');
      expect(
        (await page.request.delete('/api/libraries/' + old.id, { headers: { origin } })).ok(),
      ).toBeTruthy();
      const before = await (
        await page.request.get('/api/libraries/' + current.id + '/manifest')
      ).json();
      await page.goto('/#notes');
      const sourceWrites: string[] = [];
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (
          request.method() !== 'GET' &&
          (pathname === '/api/import' ||
            pathname.endsWith('/sync') ||
            pathname === '/api/libraries')
        )
          sourceWrites.push(pathname);
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        await sync(page);
        await expect(
          page
            .locator('.library-section > .library-grid .library-card')
            .filter({ has: page.getByRole('heading', { name: 'sync-regression', exact: true }) }),
        ).toHaveCount(1);
        await expect(page.locator('.local-library-archives > summary')).toHaveText(
          '仅本机保留 (1)',
        );
        expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe(draft);
        expect(
          await (await page.request.get('/api/libraries/' + current.id + '/manifest')).json(),
        ).toEqual(before);
      }
      expect(sourceWrites).toEqual([]);
      await page.locator('.local-library-archives > summary').click();
      await expect(
        page.getByRole('region', { name: '仅本机保留的项目' }).locator('.library-card'),
      ).toHaveCount(1);
      await page.reload();
      await expect(
        page
          .locator('.library-section > .library-grid .library-card')
          .filter({ has: page.getByRole('heading', { name: 'sync-regression', exact: true }) }),
      ).toHaveCount(1);
      await expect(page.locator('.local-library-archives > summary')).toHaveText('仅本机保留 (1)');
      await page.locator('.local-library-archives > summary').click();
      await page.screenshot({ path: '.local/mobile-sync-fix-20261128/archives-' + width + '.png' });
      await context.setOffline(true);
      await page.getByRole('region', { name: '仅本机保留的项目' }).locator('.library-card').click();
      await expect(activeReader(page)).toContainText('Retain this synthetic draft');
      await activeReader(page).getByRole('button', { name: '查看原文', exact: true }).click();
      await expect(
        activeReader(page).getByRole('heading', { name: 'Retained local source' }),
      ).toBeVisible();
      expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe(draft);
      await context.setOffline(false);
      await page.goto('/#notes/' + current.id + '?file=note.md');
      await expect(
        activeReader(page).getByRole('heading', { name: 'Current cloud source' }),
      ).toBeVisible();
      if (width < 761) await page.getByRole('button', { name: '打开目录', exact: true }).click();
      await expect(page.locator('.tree-file')).toHaveCount(3);
      await expect(
        page.locator('.tree-file').filter({ hasText: 'intentional-copy.md' }),
      ).toHaveCount(1);
    },
  );
}
