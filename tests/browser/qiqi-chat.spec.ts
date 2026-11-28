import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { readerControl, closeReaderTools } from './reader-controls';

const origin = 'http://127.0.0.1:4319';
const endpoint = 'https://qiqi-api.example/v1/chat/completions';
const secret = 'synthetic-qiqi-key';
const code =
  'export const answer = 42;\nexport const next = answer + 1;\n' +
  Array.from({ length: 80 }, (_, index) => `// readable row ${index}`).join('\n');
const note = '# 七七阅读样例\n\n这一段说明输入和输出。\n\n' + '后续阅读内容。\n\n'.repeat(80);
let libraryId = '';
const panel = (page: Page) => page.locator('.reader-panel:not([hidden])');
const chat = (page: Page) => page.getByRole('dialog', { name: '七七', exact: true });
const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
const headers = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

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
  const archive = zipSync(
    Object.fromEntries(
      Object.entries({
        'code.ts': code,
        'note.md': note,
        'not-selected.md': 'NEVER_SEND_THIS_UNSELECTED_FILE',
      }).map(([path, value]) => [path, strToU8(value)]),
    ),
  );
  const response = await page.request.post('/api/import?kind=notes&name=qiqi-fixture', {
    headers: { origin },
    multipart: {
      file: { name: 'qiqi.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) },
    },
  });
  expect(response.ok()).toBeTruthy();
  libraryId = (await response.json()).library.id;
});
test.afterEach(async ({ page }) => {
  if (libraryId) await page.request.delete(`/api/libraries/${libraryId}`, { headers: { origin } });
  libraryId = '';
});
async function configure(page: Page, remember = false) {
  const dialog = chat(page);
  await dialog.getByRole('button', { name: '七七 API 设置' }).click();
  await dialog
    .getByRole('textbox', { name: 'API 地址', exact: true })
    .fill('https://qiqi-api.example/v1');
  await dialog.getByRole('textbox', { name: '模型', exact: true }).fill('synthetic-model');
  await dialog.getByLabel('API Key', { exact: true }).fill(secret);
  await dialog.getByRole('checkbox', { name: '在此设备记住密钥' }).setChecked(remember);
  await dialog.getByRole('button', { name: '保存 API 设置' }).click();
}
async function reopenChat(page: Page) {
  const launcher = page.getByRole('button', { name: '打开七七' });
  if (await launcher.isVisible()) await launcher.click();
  else await panel(page).getByRole('button', { name: '选段问七七' }).click();
}
async function selectText(page: Page, selector: string) {
  await panel(page)
    .locator(selector)
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('.qiqi-panel')!;
    const rect = dialog.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      viewport: innerWidth,
      height: innerHeight,
      width: dialog.clientWidth,
      scrollWidth: dialog.scrollWidth,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
}

for (const width of [373, 412, 1440]) {
  test(`selected code chats, follows up and becomes a new annotation at ${width}px`, async ({
    page,
  }, info) => {
    test.skip((width === 1440) !== (info.project.name === 'desktop'));
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 915 });
    const requests: any[] = [];
    await page.route(endpoint, async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers });
        return;
      }
      expect(route.request().headers().authorization).toBe(`Bearer ${secret}`);
      expect(route.request().headers().cookie).toBeUndefined();
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: 'text/event-stream',
        headers,
        body: sse('这段代码定义了一个常量。\n\n```ts\nconst answer = 42;\n```'),
      });
    });
    await page.goto(`/#notes/${libraryId}?file=code.ts`);
    const reader = panel(page);
    await expect(reader.locator('.cm-content')).toBeVisible();
    await reader.locator('.cm-content').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+End');
    const selected = await page.evaluate(() => window.getSelection()?.toString());
    expect(selected).toContain('answer');
    const scroll = await reader.locator('.cm-scroller').evaluate((element) => element.scrollTop);
    await reader.getByRole('button', { name: '选段问七七' }).click();
    await expect(chat(page).locator('.qiqi-pending-context')).toContainText('code.ts · L1');
    await configure(page);
    expect(requests).toHaveLength(0);
    await chat(page).getByRole('button', { name: '解释这段内容', exact: true }).click();
    await chat(page).getByRole('button', { name: '发送', exact: true }).click();
    await expect(chat(page).locator('.qiqi-answer').first()).toContainText('定义了一个常量');
    expect(requests).toHaveLength(1);
    const prompt = requests[0].messages.at(-1).content;
    expect(prompt).toContain('export const answer = 42;');
    expect(prompt).not.toContain('export const next');
    expect(JSON.stringify(requests)).not.toContain('NEVER_SEND');
    expect(JSON.stringify(requests)).not.toContain(secret);
    await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('如果改成 let 呢？');
    await chat(page).getByRole('button', { name: '发送', exact: true }).click();
    await expect(chat(page).locator('.qiqi-answer')).toHaveCount(2);
    await expect(chat(page).locator('.qiqi-answer').last()).toContainText('定义了一个常量');
    expect(requests[1].messages.map((message: any) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    await chat(page).getByRole('button', { name: '另存为批注', exact: true }).last().click();
    await chat(page).getByRole('textbox', { name: '七七批注草稿' }).fill('我确认保存的阅读理解');
    await chat(page).getByRole('button', { name: '确认保存批注' }).click();
    await expect(chat(page).getByRole('status')).toContainText('已另存为本机批注，等待同步');
    const bounds = await geometry(page);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
    expect(bounds.pageWidth).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.local/screenshots/qiqi-${width}.png` });
    await chat(page).getByRole('button', { name: '关闭七七' }).click();
    await expect(chat(page)).toHaveCount(0);
    expect(await reader.locator('.cm-scroller').evaluate((element) => element.scrollTop)).toBe(
      scroll,
    );
    await expect(reader.locator('.reader-annotations')).toContainText('我确认保存的阅读理解');
    await page.screenshot({ path: `.local/screenshots/qiqi-reader-${width}.png` });
    const beforeSync = await page.request.get(
      `/api/libraries/${libraryId}/annotations?path=code.ts`,
    );
    expect((await beforeSync.json()).annotations).toEqual([]);
    await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
    await (await readerControl(page, '同步')).click();
    await expect(page.getByRole('button', { name: '正在同步', exact: true })).toHaveCount(0);
    await closeReaderTools(page);
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/libraries/${libraryId}/annotations?path=code.ts`)
            ).json()
          ).annotations.length,
      )
      .toBe(1);
    const original = await page.request.get(`/api/libraries/${libraryId}/file?path=code.ts`);
    expect(await original.text()).toBe(code);
    await reopenChat(page);
    await expect(chat(page).locator('.qiqi-answer')).toHaveCount(2);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith('codesip:qiqi:') && key.endsWith(':conversations'))
            .some((key) => localStorage.getItem(key)?.includes('如果改成')),
        ),
      )
      .toBe(true);
    await page.reload();
    await reopenChat(page);
    await expect(chat(page).locator('.qiqi-answer')).toHaveCount(2);
    await chat(page).getByRole('button', { name: '七七 API 设置' }).click();
    await expect(chat(page).getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(chat(page).getByRole('textbox', { name: '模型', exact: true })).toHaveValue(
      'synthetic-model',
    );
  });
}

test('annotation draft and selected markdown survive opening chat; a reply never replaces the original annotation', async ({
  page,
}) => {
  let payload: any;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    payload = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'text/event-stream',
      headers,
      body: sse('可以把这段理解改写为：输入经过处理后产生输出。'),
    });
  });
  await page.goto(`/#notes/${libraryId}?file=note.md`);
  await expect(panel(page).locator('.markdown-content')).toHaveAttribute(
    'data-render-complete',
    'true',
  );
  await selectText(page, '.markdown-content p');
  await panel(page).getByRole('button', { name: '添加笔记批注' }).click();
  const annotation = page.getByRole('dialog', { name: '添加批注', exact: true });
  await annotation.getByRole('textbox', { name: '批注内容' }).fill('我的原始理解');
  await annotation.getByRole('button', { name: '保存批注', exact: true }).click();
  await panel(page).locator('.annotation-pill').click();
  const editing = page.getByRole('dialog', { name: '编辑批注', exact: true });
  await editing.getByRole('textbox', { name: '批注内容' }).fill('尚未保存的改写草稿');
  await editing.getByRole('button', { name: '问七七', exact: true }).click();
  await configure(page);
  await chat(page).getByRole('button', { name: '检查我的理解', exact: true }).click();
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect(chat(page).locator('.qiqi-answer')).toContainText('输入经过处理');
  expect(payload.messages.at(-1).content).toContain('这一段说明输入和输出。');
  expect(payload.messages.at(-1).content).toContain('尚未保存的改写草稿');
  expect(payload.messages.at(-1).content).not.toContain('后续阅读内容');
  await chat(page).getByRole('button', { name: '另存为批注', exact: true }).click();
  await chat(page).getByRole('button', { name: '确认保存批注' }).click();
  await chat(page).getByRole('button', { name: '关闭七七' }).click();
  await expect(editing.getByRole('textbox', { name: '批注内容' })).toHaveValue(
    '尚未保存的改写草稿',
  );
  await editing.getByRole('button', { name: '关闭批注' }).click();
  await expect(panel(page).locator('.annotation-pill')).toHaveCount(2);
  await expect(panel(page).locator('.reader-annotations')).toContainText('我的原始理解');
  await expect(panel(page).locator('.reader-annotations')).toContainText('输入经过处理');
  expect(
    await (await page.request.get(`/api/libraries/${libraryId}/file?path=note.md`)).text(),
  ).toBe(note);
  // Opening a direct selection does not require creating or saving an annotation.
  await selectText(page, '.markdown-content p');
  await panel(page).getByRole('button', { name: '选段问七七' }).click();
  await expect(chat(page).locator('.qiqi-pending-context')).toContainText('note.md');
  await page.goBack();
  await expect(chat(page)).toHaveCount(0);
  await expect(panel(page).locator('.markdown-content')).toBeVisible();
});

test('API errors are retryable and clearing private data aborts chat and removes credentials', async ({
  page,
}) => {
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let released = false;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    attempts++;
    if (attempts === 3) {
      await gate;
      await route
        .fulfill({ contentType: 'text/event-stream', headers, body: sse('退出后的迟到回答') })
        .catch(() => {});
      released = true;
      return;
    }
    await route.fulfill(
      attempts === 1
        ? { status: 401, headers, body: 'echoed synthetic-qiqi-key must never appear' }
        : { contentType: 'text/event-stream', headers, body: sse('重试成功') },
    );
  });
  await page.goto('/#notes');
  await page.getByRole('button', { name: '打开七七' }).click();
  await configure(page, true);
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('你好七七');
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect(chat(page).getByRole('alert')).toContainText('检查密钥');
  await expect(chat(page)).not.toContainText(secret);
  await chat(page).getByRole('button', { name: '重试回答' }).click();
  await expect(chat(page).locator('.qiqi-answer')).toContainText('重试成功');
  await expect(chat(page).locator('.qiqi-user')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some(
          (key) =>
            key.startsWith('codesip:qiqi:') &&
            key.endsWith(':config') &&
            localStorage.getItem(key)?.includes('synthetic-qiqi-key'),
        ),
      ),
    )
    .toBe(true);
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('退出时仍在等待的问题');
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => attempts).toBe(3);
  await chat(page).getByRole('button', { name: '关闭七七' }).click();
  await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  await page.request.delete(`/api/libraries/${libraryId}`, { headers: { origin } });
  libraryId = '';
  await page.getByRole('button', { name: '账号与退出' }).click();
  await page
    .getByRole('dialog', { name: '当前账号' })
    .getByRole('button', { name: '退出登录', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '进入 CodeSip', exact: true })).toBeVisible();
  release();
  await expect.poll(() => released).toBe(true);
  await expect(page.locator('body')).not.toContainText('退出后的迟到回答');
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('codesip:qiqi:')),
    ),
  ).toEqual([]);
});

test('stopping a pending request keeps the question and allows a fresh retry', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  let released = false;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    attempts++;
    if (attempts > 1) {
      await route.fulfill({ contentType: 'text/event-stream', headers, body: sse('重新回答成功') });
      return;
    }
    await gate;
    await route
      .fulfill({ contentType: 'text/event-stream', headers, body: sse('晚到的回答') })
      .catch(() => {});
    released = true;
  });
  await page.goto('/#notes');
  await page.getByRole('button', { name: '打开七七' }).click();
  await configure(page);
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('需要一点时间的问题');
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => attempts).toBe(1);
  await chat(page).getByRole('button', { name: '停止生成' }).click();
  await expect(chat(page).getByRole('button', { name: '重试回答' })).toBeVisible();
  release();
  await expect.poll(() => released).toBe(true);
  await expect(chat(page).locator('.qiqi-message-status')).toHaveText('已停止');
  await expect(chat(page)).not.toContainText('晚到的回答');
  await expect(chat(page).locator('.qiqi-user')).toContainText('需要一点时间的问题');
  await chat(page).getByRole('button', { name: '重试回答' }).click();
  await expect(chat(page).locator('.qiqi-answer')).toHaveText('重新回答成功');
  await expect(chat(page).locator('.qiqi-user')).toHaveCount(1);
  expect(attempts).toBe(2);
});

test('a failed annotation write keeps the edited reply and can be retried without duplicates', async ({
  page,
}) => {
  await page.route(endpoint, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      headers,
      body: sse('建议保存的说明'),
    }),
  );
  await page.goto(`/#notes/${libraryId}?file=code.ts`);
  await panel(page).getByRole('button', { name: '选段问七七' }).click();
  await configure(page);
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('解释当前行');
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect(chat(page).locator('.qiqi-answer')).toContainText('建议保存的说明');
  await chat(page).getByRole('button', { name: '另存为批注', exact: true }).click();
  await chat(page).getByRole('textbox', { name: '七七批注草稿' }).fill('我编辑后确认的草稿');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).qiqiStorageFull = true;
    Storage.prototype.setItem = function (key, value) {
      if ((window as any).qiqiStorageFull && key.startsWith('codesip:annotations:'))
        throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await chat(page).getByRole('button', { name: '确认保存批注' }).click();
  await expect(chat(page).getByRole('textbox', { name: '七七批注草稿' })).toHaveValue(
    '我编辑后确认的草稿',
  );
  await expect(page.locator('.toast')).toContainText('批注未能保存');
  await expect(panel(page).locator('.annotation-pill')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).qiqiStorageFull = false;
  });
  await chat(page).getByRole('button', { name: '确认保存批注' }).click();
  await expect(chat(page).getByRole('status')).toContainText('已另存为本机批注');
  await chat(page).getByRole('button', { name: '关闭七七' }).click();
  await expect(panel(page).locator('.annotation-pill')).toHaveCount(1);
  await expect(panel(page).locator('.annotation-pill')).toContainText('我编辑后确认的草稿');
});

test('switching conversations cancels deletion intended for the previous conversation', async ({
  page,
}) => {
  await page.route(endpoint, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      headers,
      body: sse('已收到问题'),
    }),
  );
  await page.goto('/#notes');
  await page.getByRole('button', { name: '打开七七' }).click();
  await configure(page);
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('保留第一段对话');
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect(chat(page).locator('.qiqi-answer')).toContainText('已收到问题');
  await chat(page).getByRole('button', { name: '新建七七对话' }).click();
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('删除第二段对话');
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect(chat(page).locator('.qiqi-answer')).toContainText('已收到问题');
  await chat(page).getByRole('button', { name: '删除当前七七对话' }).click();
  await expect(chat(page).getByRole('button', { name: '确认删除对话' })).toBeVisible();
  await chat(page)
    .getByRole('combobox', { name: '七七对话记录' })
    .selectOption({ label: '保留第一段对话' });
  await expect(chat(page).getByRole('button', { name: '确认删除对话' })).toHaveCount(0);
  await expect(chat(page).locator('.qiqi-user')).toHaveText('你保留第一段对话');
  await chat(page)
    .getByRole('combobox', { name: '七七对话记录' })
    .selectOption({ label: '删除第二段对话' });
  await chat(page).getByRole('button', { name: '删除当前七七对话' }).click();
  await chat(page).getByRole('button', { name: '确认删除对话' }).click();
  await expect(chat(page).locator('.qiqi-user')).toHaveText('你保留第一段对话');
  await expect(
    chat(page).getByRole('combobox', { name: '七七对话记录' }).locator('option'),
  ).toHaveCount(1);
});

test('long formatted replies stay inside the panel without executing HTML or fetching images', async ({
  page,
}) => {
  let externalRequests = 0;
  await page.route('https://qiqi-images.example/**', async (route) => {
    externalRequests++;
    await route.fulfill({ body: '' });
  });
  const answer = [
    '一段很长的代码示例',
    '```ts\nconst long = "' + 'example'.repeat(160) + '";\n```',
    '| 字段 | 说明 |\n| --- | --- |\n| ' + 'identifier_'.repeat(100) + ' | 示例 |',
    '![图片说明](https://qiqi-images.example/tracking.png)',
    '<img src="https://qiqi-images.example/raw.png" onerror="window.qiqiExecuted = true">',
    '<script>window.qiqiExecuted = true</script>',
    '[危险链接](javascript:alert(1))',
    '[正常链接](https://example.com)',
  ].join('\n\n');
  await page.route(endpoint, (route) =>
    route.fulfill({ contentType: 'text/event-stream', headers, body: sse(answer) }),
  );
  await page.goto('/#notes');
  await page.getByRole('button', { name: '打开七七' }).click();
  await configure(page);
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('演示格式');
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect(chat(page).locator('.qiqi-answer')).toContainText('[图片：图片说明]');
  await expect(
    chat(page).locator(
      '.qiqi-answer img, .qiqi-answer script, .qiqi-answer a[href^="javascript:"]',
    ),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).qiqiExecuted)).toBeUndefined();
  expect(externalRequests).toBe(0);
  const bounds = await geometry(page);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewport);
  const log = await chat(page)
    .locator('.qiqi-log')
    .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(log.scroll).toBeLessThanOrEqual(log.width + 1);
  await page.screenshot({ path: `.local/screenshots/qiqi-formatted-${bounds.viewport}.png` });
  await page.keyboard.press('Escape');
  await expect(chat(page)).toHaveCount(0);
});
