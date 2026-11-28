import { test, expect } from '@playwright/test';
const origin = 'http://127.0.0.1:4319';
const models = ['deepseek-ai/DeepSeek-V4.1-Flash-1017', 'GLM-5.3', 'zai-org/GLM-5.3-Flash'];
for (const width of [1440, 373, 412]) {
  test(`preset models and custom settings remain isolated at ${width}px`, async ({
    page,
  }, info) => {
    test.skip(
      (info.project.name === 'desktop') !== (width === 1440),
      'one matching device per viewport',
    );
    await page.setViewportSize({ width, height: 960 });
    const setup = (await (await page.request.get('/api/status')).json()).needsSetup;
    const auth = await page.request.post(setup ? '/api/auth/setup' : '/api/auth/login', {
      headers: { origin },
      data: {
        username: 'browser',
        password: 'browser-test-password',
        ...(setup ? { setupToken: 'browser-test-setup-key' } : {}),
      },
    });
    expect(auth.ok()).toBeTruthy();
    const calls: string[] = [];
    await page.route('https://ai.ximupowers.tech/**', async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      const body = request.postDataJSON();
      calls.push(body.model);
      expect(request.headers().authorization).toBe('Bearer synthetic-preset-key');
      expect(JSON.stringify(body)).not.toContain('synthetic-preset-key');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: `合成回答 ${body.model}` } }] }),
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '打开七七' }).click();
    const dialog = page.getByRole('dialog', { name: '七七', exact: true });
    for (const model of models) {
      await dialog.getByRole('button', { name: '七七 API 设置' }).click();
      await expect(dialog.getByRole('textbox', { name: 'API 地址', exact: true })).toHaveValue(
        'https://ai.ximupowers.tech/v1',
      );
      const selector = dialog.getByRole('combobox', { name: '模型', exact: true });
      await expect(selector.locator('option')).toHaveCount(3);
      await selector.selectOption(model);
      await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-preset-key');
      await dialog.getByRole('button', { name: '保存 API 设置' }).click();
      await dialog.getByRole('textbox', { name: '给七七的消息' }).fill('合成问题');
      await dialog.getByRole('button', { name: '发送', exact: true }).click();
      await expect(dialog.getByText(`合成回答 ${model}`, { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '停止生成' })).toHaveCount(0);
    }
    expect(calls).toEqual(models);
    await dialog.getByRole('button', { name: '七七 API 设置' }).click();
    await dialog.getByRole('checkbox', { name: '在此设备记住密钥' }).check();
    await dialog
      .getByRole('textbox', { name: 'API 地址', exact: true })
      .fill('https://ai.ximupowers.tech/v1/chat/completions');
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-preset-key');
    await dialog
      .getByRole('textbox', { name: 'API 地址', exact: true })
      .fill('https://custom.example/v1');
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(dialog.getByRole('checkbox', { name: '在此设备记住密钥' })).not.toBeChecked();
    await dialog.getByRole('textbox', { name: '模型', exact: true }).fill('custom-model');
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-other-provider-key');
    await dialog.getByRole('button', { name: '保存 API 设置' }).click();
    await dialog.getByRole('button', { name: '七七 API 设置' }).click();
    await expect(dialog.getByRole('textbox', { name: '模型', exact: true })).toHaveValue(
      'custom-model',
    );
    await dialog.getByRole('button', { name: '使用七七预设' }).click();
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-preset-key');
    await dialog
      .getByRole('textbox', { name: 'API 地址', exact: true })
      .fill('https://custom.example/v1');
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-other-provider-key');
    await dialog
      .getByRole('textbox', { name: 'API 地址', exact: true })
      .fill('https://ai.ximupowers.tech/v1');
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
    await page.screenshot({
      path: `.local/decoupling-acceptance-20261128/qiqi-settings-${width}.png`,
    });
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-preset-key');
    await dialog
      .getByRole('textbox', { name: 'API 地址', exact: true })
      .fill('https://custom.example/v1');
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-other-provider-key');
    await dialog.getByRole('button', { name: '使用七七预设' }).click();
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: '关闭七七' }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.dispatchEvent(new Event('codesip:before-update', { cancelable: true })),
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith('codesip:qiqi:'))
          .some((key) => /synthetic-.*-key/.test(localStorage.getItem(key) || '')),
      ),
    ).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
