import { expect, type Page } from '@playwright/test';

// Mobile reader actions live in the overflow menu; desktop and home keep their toolbar.
export async function readerControl(page: Page, name: string) {
  await page.locator('.app').waitFor({ state: 'visible' });
  const target = page.getByRole('button', { name, exact: true });
  if (!(await target.isVisible())) {
    const tools = page.getByRole('button', { name: '阅读工具', exact: true });
    if (await tools.isVisible()) {
      if ((await tools.getAttribute('aria-expanded')) !== 'true') await tools.click();
    }
  }
  return target;
}

export async function closeReaderTools(page: Page) {
  const tools = page.getByRole('button', { name: '阅读工具', exact: true });
  if ((await tools.isVisible()) && (await tools.getAttribute('aria-expanded')) === 'true') {
    await tools.click();
    await expect.poll(() => page.evaluate(() => history.state?.codesipLayer)).toBeUndefined();
  }
}
