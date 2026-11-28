import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

const origin = 'http://127.0.0.1:4319';
const endpoint = 'https://pi-fixture.example/v1/chat/completions';
const file =
  '// SELECTED_REFERENCE\nexport const SECOND_LINE = 42;\nexport const THIRD_LINE = 43;\n';
const headers = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const chat = (page: Page) => page.getByRole('dialog', { name: '七七', exact: true });
const reader = (page: Page) => page.locator('.reader-panel:not([hidden])');
let libraryId = '',
  userId = '';

test.beforeEach(async ({ page }) => {
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
  const archive = zipSync({
    'source.ts': strToU8(file),
    'other.md': strToU8('NEVER_SEND_OTHER_FILE'),
  });
  const imported = await page.request.post('/api/import?kind=code&name=Pi-navigation-fixture', {
    headers: { origin },
    multipart: {
      file: { name: 'pi.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) },
    },
  });
  expect(imported.ok()).toBeTruthy();
  libraryId = (await imported.json()).library.id;
});
test.afterEach(async ({ page }) => {
  if (libraryId) await page.request.delete(`/api/libraries/${libraryId}`, { headers: { origin } });
  libraryId = '';
});
async function configure(page: Page) {
  const dialog = chat(page);
  await dialog.getByRole('button', { name: '七七 API 设置' }).click();
  await dialog
    .getByRole('textbox', { name: 'API 地址', exact: true })
    .fill('https://pi-fixture.example/v1');
  await dialog.getByRole('textbox', { name: '模型', exact: true }).fill('pi-test-model');
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-pi-key');
  await dialog.getByRole('button', { name: '保存 API 设置' }).click();
}
async function attach(page: Page) {
  await reader(page)
    .locator('.cm-line')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
  await reader(page).getByRole('button', { name: '选段问七七' }).click();
}
async function send(page: Page, value = '请解释相关内容') {
  await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill(value);
  await chat(page).getByRole('button', { name: '发送', exact: true }).click();
}
async function mockModel(page: Page, requests: any[]) {
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON();
    requests.push(body);
    const needsTool = body.tools && body.messages.at(-1).role !== 'tool';
    const message = needsTool
      ? {
          tool_calls: [
            {
              id: 'read-1',
              type: 'function',
              function: {
                name: 'read_reference',
                arguments: JSON.stringify({ startLine: 2, lineCount: 2 }),
              },
            },
          ],
        }
      : {
          content:
            body.messages.at(-1).role === 'tool' ? '根据工具结果完成解释' : '根据所选片段完成解释',
        };
    await route.fulfill({
      status: 200,
      headers,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message, finish_reason: needsTool ? 'tool_calls' : 'stop' }],
      }),
    });
  });
}

for (const width of [373, 412, 1440]) {
  test(`Qiqi menu, top theme and Pi reading permission at ${width}px`, async ({ page }, info) => {
    test.skip((width === 1440) !== (info.project.name === 'desktop'));
    await page.setViewportSize({ width, height: 915 });
    const requests: any[] = [];
    await mockModel(page, requests);
    await page.goto('/#code');
    const nav = page.locator(width === 1440 ? '.sidebar nav' : '.mobile-nav');
    await expect(nav.getByRole('button', { name: '打开七七', exact: true })).toContainText('七七');
    await expect(nav.getByRole('button')).toHaveCount(3);
    await expect(nav.getByRole('button', { name: '阅读主题' })).toHaveCount(0);
    const theme = page.getByRole('button', { name: '切换明暗主题', exact: true });
    await theme.click();
    await page
      .getByRole('dialog', { name: '阅读主题', exact: true })
      .getByRole('button', { name: '羊皮纸棕', exact: false })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia-parchment');
    await expect(theme).toBeFocused();
    await nav.getByRole('button', { name: '打开七七' }).click();
    await chat(page).getByRole('textbox', { name: '给七七的消息' }).fill('保留跨页面输入');
    await configure(page);
    await chat(page).getByRole('button', { name: '关闭七七' }).click();
    await page.screenshot({ path: `.local/qiqi-pi-20261128/navigation-${width}.png` });
    await page.evaluate((id) => {
      location.hash = `code/${id}?file=source.ts`;
    }, libraryId);
    await expect(reader(page).locator('.cm-editor')).toBeVisible();
    await page.getByRole('button', { name: '打开七七', exact: true }).click();
    await expect(chat(page).getByRole('textbox', { name: '给七七的消息' })).toHaveValue(
      '保留跨页面输入',
    );
    await chat(page).getByRole('button', { name: '关闭七七' }).click();
    await theme.click();
    await page
      .getByRole('dialog', { name: '阅读主题', exact: true })
      .getByRole('button', { name: '素笺暖白', exact: false })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper-light');
    await expect(theme).toBeFocused();
    await page.screenshot({ path: `.local/qiqi-pi-20261128/reader-${width}.png` });
    await attach(page);
    const permission = chat(page).getByRole('checkbox', {
      name: '本次允许读取这份原文',
      exact: false,
    });
    await expect(permission).not.toBeChecked();
    await send(page);
    await expect(chat(page).locator('.qiqi-answer').last()).toContainText('根据所选片段');
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain('SECOND_LINE');
    await chat(page).getByRole('button', { name: '关闭七七' }).click();
    await attach(page);
    await permission.check();
    await send(page, '请读取原文第2至3行并解释');
    await expect(chat(page).locator('.qiqi-answer').last()).toContainText('根据工具结果');
    expect(requests).toHaveLength(3);
    expect(requests[1].tools[0].function.name).toBe('read_reference');
    expect(requests[2].messages.at(-1).content).toContain('2: export const SECOND_LINE');
    expect(requests[2].messages.at(-1).content).toContain('3: export const THIRD_LINE');
    expect(JSON.stringify(requests)).not.toContain('NEVER_SEND_OTHER_FILE');
    expect(JSON.stringify(requests)).not.toContain('synthetic-pi-key');
    await send(page, '继续说明');
    await expect(chat(page).locator('.qiqi-answer').last()).toContainText('根据所选片段');
    expect(requests).toHaveLength(4);
    expect(requests[3].tools).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: `.local/qiqi-pi-20261128/chat-${width}.png` });
    await chat(page).getByRole('button', { name: '关闭七七' }).click();
    expect(await reader(page).locator('.cm-content').textContent()).toContain('SECOND_LINE');
    const manifest = await (await page.request.get(`/api/libraries/${libraryId}/manifest`)).json();
    const entry = manifest.files.find((entry: any) => entry.path === 'source.ts');
    const original = await page.request.get(
      `/api/libraries/${libraryId}/file?path=source.ts&hash=${entry.hash}`,
    );
    expect(await original.text()).toBe(file);
  });
}

test('Pi refuses a source whose current hash differs from the attached version', async ({
  page,
}) => {
  const requests: any[] = [];
  await mockModel(page, requests);
  await page.goto(`/#code/${libraryId}?file=source.ts`);
  await expect(reader(page).locator('.cm-editor')).toBeVisible();
  await page.evaluate(
    ({ userId, libraryId }) =>
      window.dispatchEvent(
        new CustomEvent('codesip:ask-qiqi', {
          detail: {
            identity: { userId, libraryId, path: 'source.ts' },
            line: 1,
            snippet: '// old source',
            sourceHash: '0'.repeat(64),
          },
        }),
      ),
    { userId, libraryId },
  );
  await configure(page);
  await chat(page).getByRole('checkbox', { name: '本次允许读取这份原文', exact: false }).check();
  await send(page);
  await expect(chat(page).locator('.qiqi-answer').last()).toContainText('根据工具结果');
  expect(requests[1].messages.at(-1).content).toContain('原文版本已变化');
  expect(JSON.stringify(requests)).not.toContain('SECOND_LINE');
});
