import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type IncomingHttpHeaders } from 'node:http';

const origin = 'http://127.0.0.1:4319';
const secret = 'synthetic-direct-client-key';
const model = 'synthetic-direct-model';
const question = 'SYNTHETIC_DIRECT_NETWORK_QUESTION';
const answer = '这条回答通过真实的跨域连接返回。';
const chat = (page: Page) => page.getByRole('dialog', { name: '七七', exact: true });
type Gateway = {
  baseUrl: string;
  calls: { path: string; headers: IncomingHttpHeaders; body: Record<string, any> }[];
  preflights: number;
};

// A real second-origin server is essential here: page.route() can bypass CSP and
// conceal exactly the production connect-src regression this suite must catch.
const test = base.extend<{ gateway: Gateway }>({
  gateway: async ({}, use) => {
    const gateway: Gateway = { baseUrl: '', calls: [], preflights: 0 };
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Max-Age', '0');
      if (request.method === 'OPTIONS') {
        gateway.preflights++;
        response.writeHead(204).end();
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        gateway.calls.push({ path: request.url!, headers: request.headers, body });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    gateway.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      await use(gateway);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
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

async function configure(page: Page, gateway: Gateway, legacyPolicy = false) {
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain(
    legacyPolicy ? "connect-src 'self';" : "connect-src 'self' https:",
  );
  await page.getByRole('button', { name: '打开七七', exact: true }).click();
  const dialog = chat(page);
  await dialog.getByRole('button', { name: '七七 API 设置' }).click();
  await dialog.getByRole('textbox', { name: 'API 地址', exact: true }).fill(gateway.baseUrl);
  await dialog.getByRole('textbox', { name: '模型', exact: true }).fill(model);
  await dialog.getByLabel('API Key', { exact: true }).fill(secret);
  return dialog;
}

for (const width of [373, 412, 1440]) {
  test(`Pi chat connects directly through the real page policy at ${width}px`, async ({
    page,
    gateway,
  }, info) => {
    test.skip((width === 1440) !== (info.project.name === 'desktop'));
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 915 });
    let sentPrivateDataToCodeSip = false;
    page.on('request', (request) => {
      if (!request.url().startsWith(`${origin}/api/`)) return;
      const data = JSON.stringify(request.headers()) + (request.postData() || '');
      if (data.includes(secret) || data.includes(question)) sentPrivateDataToCodeSip = true;
    });
    const dialog = await configure(page, gateway);
    await dialog.getByRole('button', { name: '保存 API 设置' }).click();
    await expect(dialog.getByRole('textbox', { name: '给七七的消息' })).toBeVisible();
    expect(gateway.calls).toHaveLength(0);
    expect(
      await page.evaluate(
        (key) =>
          Object.keys(localStorage).some(
            (name) =>
              name.startsWith('codesip:qiqi:') && (localStorage.getItem(name) || '').includes(key),
          ),
        secret,
      ),
    ).toBe(false);
    await dialog.getByRole('textbox', { name: '给七七的消息' }).fill(question);
    await dialog.getByRole('button', { name: '发送', exact: true }).click();
    await expect(dialog.getByText(answer, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '停止生成' })).toHaveCount(0);
    expect(gateway.preflights).toBeGreaterThan(0);
    expect(gateway.calls).toHaveLength(1);
    const call = gateway.calls[0];
    expect(call.body.model).toBe(model);
    expect(call.body.messages).toContainEqual({ role: 'user', content: question });
    expect(call.body.tools).toBeUndefined();
    expect(call.headers.authorization).toBe(`Bearer ${secret}`);
    expect(call.headers.origin).toBe(origin);
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers.referer).toBeUndefined();
    expect(JSON.stringify(call.body)).not.toContain(secret);
    expect(sentPrivateDataToCodeSip).toBe(false);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('the old page policy prevents the real agent request from reaching its API', async ({
  page,
  gateway,
}) => {
  const dialog = await configure(page, gateway);
  await dialog.getByRole('button', { name: '保存 API 设置' }).click();
  await page.evaluate(() => {
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "connect-src 'self'";
    document.head.appendChild(policy);
  });
  await dialog.getByRole('textbox', { name: '给七七的消息' }).fill(question);
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('连接失败');
  expect(gateway.preflights).toBe(0);
  expect(gateway.calls).toHaveLength(0);
});

test('updating a cached old policy restores the agent connection and keeps local settings/history', async ({
  page,
  gateway,
}) => {
  const oldVersion = 'beef0000beef';
  const result = await page.request.post('/__test/update-control', {
    headers: { origin },
    data: { version: oldVersion, legacyPolicy: true },
  });
  const baseVersion = (await result.json()).baseVersion;
  const version = () => page.locator('meta[name="codesip-version"]').getAttribute('content');
  try {
    const dialog = await configure(page, gateway, true);
    await dialog.getByRole('checkbox', { name: '在此设备记住密钥' }).check();
    await dialog.getByRole('button', { name: '保存 API 设置' }).click();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload();
    expect(await version()).toBe(oldVersion);
    await page.getByRole('button', { name: '打开七七', exact: true }).click();
    await dialog.getByRole('textbox', { name: '给七七的消息' }).fill(question);
    await dialog.getByRole('button', { name: '发送', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('连接失败');
    expect(gateway.calls).toHaveLength(0);
    await dialog.getByRole('button', { name: '关闭七七' }).click();
    await page.request.post('/__test/update-control', { headers: { origin }, data: {} });
    await page.evaluate(() => window.dispatchEvent(new Event('codesip:check-update')));
    await expect(page.getByRole('dialog', { name: '新版已准备好' })).toBeVisible();
    await page.getByRole('button', { name: '重载更新', exact: true }).click();
    await expect.poll(version).toBe(baseVersion);
    await page.getByRole('button', { name: '打开七七', exact: true }).click();
    await expect(dialog.getByText(question, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '七七 API 设置' }).click();
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue(secret);
    await dialog.getByRole('button', { name: '返回对话' }).click();
    await dialog.getByRole('button', { name: '重试回答', exact: true }).click();
    await expect(dialog.getByText(answer, { exact: true })).toBeVisible();
    expect(gateway.calls).toHaveLength(1);
  } finally {
    await page.request.post('/__test/update-control', { headers: { origin }, data: {} });
  }
});
