import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { closeReaderTools, readerControl } from './reader-controls';

const origin = 'http://127.0.0.1:4319';
const source = Array.from(
  { length: 180 },
  (_, row) =>
    `export const row${String(row).padStart(4, '0')} = "${Array.from(
      { length: 100 },
      (_, column) => `word${String(column).padStart(3, '0')}`,
    ).join(' ')}";`,
).join('\n');
const foldSource = `export function kept() {\n  return 'original';\n}\n${source}`;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
let libraryId = '';

const panel = (page: Page) => page.locator('.reader-panel:not([hidden])');
const editor = (page: Page) => panel(page).locator('.cm-editor');
const scroller = (page: Page) => editor(page).locator('.cm-scroller');

// Wait for CodeMirror's measure/draw cycle, including ResizeObserver delivery.
// No editor internals or production test hooks are needed to verify the viewport.
async function settled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
}

interface SourceAnchor {
  text: string;
  offset: number;
  x: number;
  y: number;
}

async function anchorGeometry(target: Locator, saved?: SourceAnchor): Promise<SourceAnchor | null> {
  return target.evaluate((element, saved) => {
    const surface = element.querySelector('.cm-scroller')!;
    const bounds = surface.getBoundingClientRect();
    const gutter = element.querySelector('.cm-gutters')?.getBoundingClientRect().width || 0;
    let line: Element | null;
    let offset: number;
    if (saved) {
      line =
        [...element.querySelectorAll('.cm-line')].find((item) => item.textContent === saved.text) ||
        null;
      offset = saved.offset;
    } else {
      const lineHeight = parseFloat(getComputedStyle(surface).lineHeight);
      const caret = (
        document as Document & {
          caretRangeFromPoint(x: number, y: number): Range | null;
        }
      ).caretRangeFromPoint(bounds.left + gutter + 9, bounds.top + lineHeight / 2);
      line = caret?.startContainer.parentElement?.closest('.cm-line') || null;
      if (!caret || !line) return null;
      const prefix = document.createRange();
      prefix.selectNodeContents(line);
      prefix.setEnd(caret.startContainer, caret.startOffset);
      offset = prefix.toString().length;
    }
    if (!line) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const nodes: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    let remaining = offset;
    for (const [index, node] of nodes.entries()) {
      const length = node.textContent?.length || 0;
      if (remaining >= length && index < nodes.length - 1) {
        remaining -= length;
        continue;
      }
      const range = document.createRange();
      range.setStart(node, remaining);
      // A collapsed DOM caret at a wrap boundary can describe the previous row.
      // Measure the following character, matching CodeMirror's forward anchor.
      range.setEnd(node, Math.min(remaining + 1, length));
      const rect = range.getClientRects()[0];
      if (!rect) return null;
      return {
        text: line.textContent || '',
        offset,
        x: rect.left - bounds.left - gutter,
        y: rect.top - bounds.top,
      };
    }
    return null;
  }, saved);
}

async function visibleAnchor(target: Locator): Promise<SourceAnchor> {
  const anchor = await anchorGeometry(target);
  if (!anchor) throw new Error('No source character at the top of the code viewport');
  return anchor;
}

async function expectAnchor(page: Page, saved: SourceAnchor, horizontal = false) {
  // The captured character can fall on the other side of a wrap boundary. It
  // must remain in the same visual row, never drift by entire logical lines.
  const lineHeight = await scroller(page).evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  );
  await expect
    .poll(async () => {
      const current = await anchorGeometry(editor(page), saved);
      return current ? Math.abs(current.y - saved.y) : Infinity;
    })
    .toBeLessThan(lineHeight + 2);
  if (horizontal) {
    await expect
      .poll(async () => {
        const current = await anchorGeometry(editor(page), saved);
        return current ? Math.abs(current.x - saved.x) : Infinity;
      })
      .toBeLessThan(16);
  }
}

async function expectContained(page: Page, wrapped: boolean) {
  const geometry = await editor(page).evaluate((element) => {
    const view = element.getBoundingClientRect();
    const surface = element.querySelector('.cm-scroller')!;
    const body = element.closest('.document-body')!.getBoundingClientRect();
    return {
      pageWidth: document.documentElement.scrollWidth,
      windowWidth: innerWidth,
      readerWidth: view.width,
      bodyWidth: body.width,
      bottom: view.bottom,
      bodyBottom: body.bottom,
      scrollWidth: surface.scrollWidth,
      clientWidth: surface.clientWidth,
      transform: getComputedStyle(element).transform,
    };
  });
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.windowWidth + 1);
  expect(Math.abs(geometry.readerWidth - geometry.bodyWidth)).toBeLessThan(2);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.bodyBottom + 1);
  expect(geometry.transform).toBe('none');
  if (wrapped) expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  else expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth + 100);
}

async function setWrap(page: Page, enabled: boolean) {
  const content = editor(page).locator('.cm-content');
  if ((await content.getAttribute('class'))?.includes('cm-lineWrapping') !== enabled)
    await (await readerControl(page, '自动换行')).click();
  await closeReaderTools(page);
  await settled(page);
}

async function openFile(page: Page, path: string) {
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `code/${libraryId}?file=${path}`);
  await expect(editor(page)).toBeVisible();
  await settled(page);
}

async function zoom(page: Page, name: '放大代码' | '缩小代码' | '重置代码字号', size: number) {
  await panel(page).getByRole('button', { name, exact: true }).click();
  await expect(editor(page)).toHaveCSS('font-size', `${size}px`);
  await settled(page);
}

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: origin });
  const needsSetup = (await (await request.get('/api/status')).json()).needsSetup;
  const response = await request.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    headers: { origin },
    data: {
      username: 'browser',
      password: 'browser-test-password',
      ...(needsSetup ? { setupToken: 'browser-test-setup-key' } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  cookies = (await request.storageState()).cookies;
  await request.dispose();
});

test.beforeEach(async ({ page, context }) => {
  await context.addCookies(cookies);
  const response = await page.request.post('/api/import?kind=code&name=code-viewport', {
    headers: { origin },
    multipart: {
      file: {
        name: 'code-viewport.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync({
            'code.ts': strToU8(source),
            'other.ts': strToU8(source.replaceAll('row', 'other')),
            'fold.ts': strToU8(foldSource),
          }),
        ),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  libraryId = (await response.json()).library.id;
});

test.afterEach(async ({ page }) => {
  if (libraryId) await page.request.delete(`/api/libraries/${libraryId}`, { headers: { origin } });
  libraryId = '';
});

for (const width of [373, 412, 1440]) {
  test(`wrapped code keeps the same source character through zoom and resize at ${width}px`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile !== width < 760, 'Each project covers its own viewport family');
    await page.setViewportSize({ width, height: width < 760 ? 915 : 960 });
    await page.goto(`/#code/${libraryId}?file=code.ts`);
    await expect(editor(page)).toBeVisible();
    await settled(page);
    await scroller(page).evaluate((element) => {
      element.scrollTop = 12000;
    });
    await settled(page);
    const saved = await visibleAnchor(editor(page));
    expect(saved.offset).toBeGreaterThan(0);
    for (let size = 15; size <= 24; size++) {
      await zoom(page, '放大代码', size);
      await expectAnchor(page, saved);
    }
    await expect(panel(page).getByRole('button', { name: '放大代码', exact: true })).toBeDisabled();
    await expectAnchor(page, saved);
    await expectContained(page, true);
    await zoom(page, '重置代码字号', 14);
    await expectAnchor(page, saved);
    for (let size = 13; size >= 10; size--) {
      await zoom(page, '缩小代码', size);
      await expectAnchor(page, saved);
    }
    await expect(panel(page).getByRole('button', { name: '缩小代码', exact: true })).toBeDisabled();
    await expectAnchor(page, saved);
    await zoom(page, '重置代码字号', 14);
    await page.setViewportSize({
      width: width === 373 ? 412 : width === 412 ? 373 : 1180,
      height: 915,
    });
    await settled(page);
    await expectAnchor(page, saved);
    await expectContained(page, true);
    await page.setViewportSize({ width, height: 915 });
    await settled(page);
    await expectAnchor(page, saved);
    await expect(editor(page).locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await zoom(page, '放大代码', 15);
    await page.reload();
    await expect(editor(page)).toHaveCSS('font-size', '15px');
    await settled(page);
    await expectAnchor(page, saved);
  });

  test(`unwrapped code scrolls within the reader and preserves its column at ${width}px`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile !== width < 760, 'Each project covers its own viewport family');
    await page.setViewportSize({ width, height: 915 });
    await page.goto(`/#code/${libraryId}?file=code.ts`);
    await expect(editor(page)).toBeVisible();
    await setWrap(page, false);
    await scroller(page).evaluate((element) => {
      element.scrollTop = 1800;
      element.scrollLeft = 620;
    });
    await settled(page);
    const saved = await visibleAnchor(editor(page));
    for (let size = 15; size <= 20; size++) await zoom(page, '放大代码', size);
    await expectAnchor(page, saved, true);
    await expectContained(page, false);
    await zoom(page, '重置代码字号', 14);
    await expectAnchor(page, saved, true);
    await setWrap(page, true);
    await expectAnchor(page, saved);
    await expectContained(page, true);
    await expect.poll(() => scroller(page).evaluate((element) => element.scrollLeft)).toBe(0);
    await setWrap(page, false);
    await expectAnchor(page, saved, true);
    await scroller(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.scrollLeft = element.scrollWidth;
    });
    await settled(page);
    await expect(editor(page).locator('.cm-content')).toContainText('row0179');
    const end = await scroller(page).evaluate((element) => ({
      left: element.scrollLeft,
      maximum: element.scrollWidth - element.clientWidth,
    }));
    expect(Math.abs(end.left - end.maximum)).toBeLessThan(2);
    await expectContained(page, false);
  });
}

test('zoom preserves selection, copying, annotations, folds and each mounted file', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/#code/${libraryId}?file=fold.ts`);
  await expect(editor(page)).toBeVisible();
  await settled(page);
  await editor(page).evaluate((element) => {
    (window as Window & { viewportEditor?: Element }).viewportEditor = element;
  });
  const content = editor(page).locator('.cm-content');
  await content.focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+Shift+ArrowRight');
  await page.keyboard.press('Control+c');
  const selected = await page.evaluate(() => navigator.clipboard.readText());
  expect(selected).toMatch(/^export/);
  await zoom(page, '放大代码', 15);
  await content.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
  await page.keyboard.type('SHOULD_NOT_EDIT');
  await expect(content).not.toContainText('SHOULD_NOT_EDIT');
  await panel(page).getByRole('button', { name: '添加标注', exact: true }).click();
  const annotation = page.getByRole('dialog', { name: '添加批注', exact: true });
  await expect(annotation).toContainText('代码批注 · 第 1 行');
  await expect(annotation.locator('.drawer-snippet')).toHaveText('export function kept() {');
  await annotation
    .getByRole('textbox', { name: '批注内容', exact: true })
    .fill('Synthetic viewport annotation');
  await annotation.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(panel(page).locator('.annotation-pill')).toContainText(
    'Synthetic viewport annotation',
  );
  await editor(page)
    .locator('.cm-foldGutter .cm-gutterElement')
    .filter({ hasText: '⌄' })
    .first()
    .click();
  await expect(editor(page).locator('.cm-foldPlaceholder')).toHaveCount(1);
  await scroller(page).evaluate((element) => {
    element.scrollTop = 12000;
  });
  await settled(page);
  const first = await visibleAnchor(editor(page));
  await openFile(page, 'other.ts');
  await setWrap(page, false);
  await scroller(page).evaluate((element) => {
    element.scrollTop = 1600;
    element.scrollLeft = 420;
  });
  await settled(page);
  const second = await visibleAnchor(editor(page));
  for (let size = 16; size <= 19; size++) await zoom(page, '放大代码', size);
  await expectAnchor(page, second, true);
  await openFile(page, 'fold.ts');
  await expect(editor(page)).toHaveCSS('font-size', '19px');
  await expectAnchor(page, first);
  expect(
    await editor(page).evaluate(
      (element) => element === (window as Window & { viewportEditor?: Element }).viewportEditor,
    ),
  ).toBe(true);
  await openFile(page, 'other.ts');
  await expectAnchor(page, second, true);
  await openFile(page, 'fold.ts');
  await scroller(page).evaluate((element) => {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  });
  await settled(page);
  await expect(editor(page).locator('.cm-foldPlaceholder')).toHaveCount(1);
  const original = await page.request.get(`/api/libraries/${libraryId}/file?path=fold.ts`);
  expect(await original.text()).toBe(foldSource);
  await page.reload();
  await expect(editor(page)).toHaveCSS('font-size', '19px');
  await expect(panel(page).locator('.annotation-pill')).toContainText(
    'Synthetic viewport annotation',
  );
});

test('logging out clears source progress without recreating it while readers unmount', async ({
  page,
  context,
}) => {
  await page.goto(`/#code/${libraryId}?file=code.ts`);
  await expect(editor(page)).toBeVisible();
  await settled(page);
  await scroller(page).evaluate((element) => {
    element.scrollTop = 12000;
  });
  await settled(page);
  await page.reload();
  await expect(editor(page)).toBeVisible();
  const savedKeys = () =>
    page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('codesip:code-viewport:')),
    );
  expect((await savedKeys()).length).toBeGreaterThan(0);
  await (await readerControl(page, '账号与退出')).click();
  await page
    .getByRole('dialog', { name: '当前账号' })
    .getByRole('button', { name: '退出登录', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  try {
    expect(await savedKeys()).toEqual([]);
  } finally {
    const login = await page.request.post('/api/auth/login', {
      headers: { origin },
      data: { username: 'browser', password: 'browser-test-password' },
    });
    expect(login.ok()).toBeTruthy();
    cookies = await context.cookies();
  }
});
