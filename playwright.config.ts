import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:4319', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 } } },
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4319/api/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
