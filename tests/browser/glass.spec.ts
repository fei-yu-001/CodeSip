import { test, expect } from '@playwright/test';
test('glass refraction bends a grid, touch tabs click and drag, and cancelled drag restores', async ({
  page,
}, info) => {
  const origin = 'http://127.0.0.1:4319';
  const status = await page.request.get('/api/status');
  if ((await status.json()).needsSetup)
    await page.request.post('/api/auth/setup', {
      headers: { origin },
      data: {
        username: 'browser',
        password: 'browser-test-password',
        setupToken: 'browser-test-setup-key',
      },
    });
  else
    await page.request.post('/api/auth/login', {
      headers: { origin },
      data: { username: 'browser', password: 'browser-test-password' },
    });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '代码项目', exact: true })).toBeVisible();
  if (info.project.name === 'mobile') {
    const nav = page.locator('.mobile-nav');
    await nav.getByRole('button', { name: '学习笔记' }).click();
    await expect(page).toHaveURL(/#notes$/);
    await nav.getByRole('button', { name: '代码项目' }).click();
    await expect(page).toHaveURL(/#code$/);
    const first = await nav.getByRole('button', { name: '代码项目' }).boundingBox(),
      second = await nav.getByRole('button', { name: '学习笔记' }).boundingBox();
    await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
    await page.mouse.down();
    await page.mouse.move(second!.x + second!.width / 2, second!.y + second!.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(page).toHaveURL(/#notes$/);
    await nav
      .getByRole('button', { name: '代码项目' })
      .dispatchEvent('pointerdown', { pointerId: 12, clientX: first!.x + 20 });
    await page.dispatchEvent('body', 'pointercancel', { pointerId: 12, clientX: first!.x + 70 });
    await expect(page).toHaveURL(/#notes$/);
    await expect(nav).not.toHaveClass(/dragging/);
  }
  await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.id = 'optics-probe';
    panel.style.cssText =
      'position:fixed;inset:110px 20px auto;z-index:200;height:190px;background:repeating-linear-gradient(0deg,transparent 0 11px,#b4d0c3 12px 13px),repeating-linear-gradient(90deg,#25414a 0 11px,#b4d0c3 12px 13px);border-radius:20px;display:grid;place-items:center';
    panel.innerHTML =
      '<label class="search-input" style="width:260px;height:64px;background:#ffffff12;color:#fff">Glass optical verification</label>';
    document.getElementById('root')!.append(panel);
  });
  const probe = page.locator('#optics-probe .search-input');
  await expect(probe).toHaveAttribute('data-optics', 'refraction');
  await page.waitForTimeout(200);
  const refraction = await page
    .locator('#optics-probe')
    .screenshot({ path: `.local/screenshots/${info.project.name}-glass-refraction.png` });
  await probe.evaluate((el) =>
    (el as HTMLElement).style.setProperty('--glass-filter', 'blur(.35px)'),
  );
  const frosted = await page
    .locator('#optics-probe')
    .screenshot({ path: `.local/screenshots/${info.project.name}-glass-fallback.png` });
  expect(refraction.equals(frosted)).toBe(false);
  await page.locator('#optics-probe').evaluate((el) => el.remove());
});
