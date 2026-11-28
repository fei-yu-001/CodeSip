import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';

const origin = 'http://127.0.0.1:4319';
const secret = 'synthetic-harmony-key';
const question = 'SYNTHETIC_HARMONY_QUESTION';
const first = '七七已通过手机客户端收到问题。';
const second = '可以继续解释阅读内容。';
const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
type NativeHarness = {
  baseUrl: string;
  requests: { headers: IncomingHttpHeaders; body: Record<string, any> }[];
  responses: ServerResponse[];
  preflights: number;
  cancels: number;
  status: number;
  error: boolean;
  errorBody: string;
};
const test = base.extend<{ native: NativeHarness }>({
  native: async ({ page }, use) => {
    const fixture: NativeHarness = {
      baseUrl: '',
      requests: [],
      responses: [],
      preflights: 0,
      cancels: 0,
      status: 200,
      error: false,
      errorBody: secret,
    };
    // This gateway deliberately supplies no CORS headers. The JS/native contract
    // crosses a real process boundary, then makes a real request outside the page.
    // This is integration emulation; it does not replace an ArkWeb device test.
    const server = createServer((request, response) => {
      if (request.method === 'OPTIONS') {
        fixture.preflights++;
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        fixture.requests.push({
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        fixture.responses.push(response);
        response.writeHead(fixture.status, {
          'content-type': fixture.status === 200 ? 'text/event-stream' : 'application/json',
        });
        if (fixture.status !== 200) {
          response.end(fixture.errorBody);
          return;
        }
        response.write(delta(first));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    fixture.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const active = new Map<string, AbortController>();
    const emit = (id: string, event: object) =>
      page.evaluate(
        ({ id, event }) => {
          (window as any).__nativeCallbacks.get(id)?.(JSON.stringify({ id, ...event }));
        },
        { id, event },
      );
    await page.exposeFunction('__nativeStart', async (raw: string) => {
      const request = JSON.parse(raw);
      const controller = new AbortController();
      active.set(request.id, controller);
      try {
        if (fixture.error) {
          await emit(request.id, { type: 'error', code: 'dns', message: secret });
          return;
        }
        const response = await fetch(request.endpoint, {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: request.authorization },
          body: request.body,
        });
        await emit(request.id, {
          type: 'headers',
          status: response.status,
          contentType: response.headers.get('content-type'),
        });
        const reader = response.body!.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          await emit(request.id, {
            type: 'data',
            data: Buffer.from(chunk.value).toString('base64'),
          });
        }
        reader.releaseLock();
        await emit(request.id, { type: 'end' });
      } catch {
        if (!controller.signal.aborted)
          await emit(request.id, { type: 'error', code: 'network' }).catch(() => {});
      } finally {
        active.delete(request.id);
      }
    });
    await page.exposeFunction('__nativeCancel', (id: string) => {
      fixture.cancels++;
      active.get(id)?.abort();
    });
    await page.addInitScript(() => {
      const target = window as any;
      target.__nativeCallbacks = new Map();
      target.CodeSipQiqi = {
        version: () => 1,
        start: (raw: string, callback: (event: string) => void) => {
          const id = JSON.parse(raw).id;
          target.__nativeCallbacks.set(id, (event: string) => {
            callback(event);
            if (['end', 'error'].includes(JSON.parse(event).type))
              target.__nativeCallbacks.delete(id);
          });
          void target.__nativeStart(raw).catch(() => {});
          return 'ok';
        },
        cancel: (id: string) => {
          target.__nativeCallbacks.delete(id);
          void target.__nativeCancel(id);
        },
      };
    });
    try {
      await use(fixture);
    } finally {
      for (const controller of active.values()) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
});
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
});
async function configure(page: Page, fixture: NativeHarness) {
  await page.goto('/');
  await page.getByRole('button', { name: '打开七七', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '七七', exact: true });
  await dialog.getByRole('button', { name: '七七 API 设置' }).click();
  await dialog.getByRole('textbox', { name: 'API 地址', exact: true }).fill(fixture.baseUrl);
  await dialog.getByRole('textbox', { name: '模型', exact: true }).fill('synthetic-native-model');
  await dialog.getByLabel('API Key', { exact: true }).fill(secret);
  await dialog.getByRole('button', { name: '保存 API 设置' }).click();
  return dialog;
}
for (const width of [373, 412, 1440]) {
  test(`native bridge streams to the Pi panel without page CORS at ${width}px`, async ({
    page,
    native,
  }, info) => {
    test.skip((width === 1440) !== (info.project.name === 'desktop'));
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 915 });
    let sentToServer = false;
    page.on('request', (request) => {
      if (!request.url().startsWith(`${origin}/api/`)) return;
      if ((JSON.stringify(request.headers()) + request.postData()).includes(secret))
        sentToServer = true;
    });
    const dialog = await configure(page, native);
    await page.evaluate(() => {
      const meta = document.createElement('meta');
      meta.httpEquiv = 'Content-Security-Policy';
      meta.content = "connect-src 'self'";
      document.head.appendChild(meta);
    });
    await dialog.getByRole('textbox', { name: '给七七的消息' }).fill(question);
    await dialog.getByRole('button', { name: '发送', exact: true }).click();
    await expect(dialog.getByText(first, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '停止生成' })).toBeVisible();
    expect(native.requests).toHaveLength(1);
    expect(native.preflights).toBe(0);
    const request = native.requests[0];
    expect(request.headers.authorization).toBe(`Bearer ${secret}`);
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
    expect(request.body.messages).toContainEqual({ role: 'user', content: question });
    native.responses[0].end(delta(second) + 'data: [DONE]\n\n');
    await expect(dialog.getByText(first + second, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '停止生成' })).toHaveCount(0);
    expect(sentToServer).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('stop cancels the native request, then a new conversation can connect', async ({
  page,
  native,
}) => {
  const dialog = await configure(page, native);
  await dialog.getByRole('textbox', { name: '给七七的消息' }).fill(question);
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByText(first, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '停止生成' }).click();
  await expect.poll(() => native.cancels).toBe(1);
  await dialog.getByRole('button', { name: '新建七七对话', exact: true }).click();
  await dialog.getByRole('textbox', { name: '给七七的消息' }).fill('SYNTHETIC_SECOND_QUESTION');
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => native.requests.length).toBe(2);
  native.responses[1].end(delta(second) + 'data: [DONE]\n\n');
  await expect(dialog.getByText(first + second, { exact: true })).toBeVisible();
});

test('native failures keep specific safe feedback and do not fall back to browser fetch', async ({
  page,
  native,
}) => {
  native.error = true;
  const dialog = await configure(page, native);
  await dialog.getByRole('textbox', { name: '给七七的消息' }).fill(question);
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('手机无法解析 API 地址');
  await expect(dialog.getByRole('alert')).not.toContainText(secret);
  await expect(dialog.getByRole('alert')).not.toContainText('CORS');
  expect(native.requests).toHaveLength(0);
  expect(native.preflights).toBe(0);
});

test('old Harmony installations give an installation update hint on connection failure', async ({
  page,
  native,
}) => {
  await page.addInitScript(() => {
    delete (window as any).CodeSipQiqi;
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (OpenHarmony) ArkWeb' });
  });
  const dialog = await configure(page, native);
  await dialog.getByRole('textbox', { name: '给七七的消息' }).fill(question);
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('更新 CodeSip 鸿蒙安装包');
  expect(native.requests).toHaveLength(0);
});

test('native 503 exposes a safe model-channel reason and leaves the question available for retry', async ({
  page,
  native,
}) => {
  native.status = 503;
  native.errorBody = JSON.stringify({
    error: {
      type: 'new_api_error',
      code: 'model_not_found',
      message: `当前分组 synthetic 下对于模型 synthetic 无可用渠道 ${secret}`,
    },
  });
  const dialog = await configure(page, native);
  await dialog.getByRole('textbox', { name: '给七七的消息' }).fill(question);
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('没有可用的模型通道（503）');
  await expect(dialog.getByRole('alert')).not.toContainText(secret);
  await expect(dialog.getByRole('alert')).not.toContainText('CORS');
  await expect(dialog.locator('.qiqi-user')).toHaveCount(1);
  expect(native.requests).toHaveLength(1);
  native.status = 200;
  await dialog.getByRole('button', { name: '重试回答', exact: true }).click();
  await expect.poll(() => native.requests.length).toBe(2);
  native.responses[1].end(delta(second) + 'data: [DONE]\n\n');
  await expect(dialog.getByText(first + second, { exact: true })).toBeVisible();
  await expect(dialog.locator('.qiqi-user')).toHaveCount(1);
});
