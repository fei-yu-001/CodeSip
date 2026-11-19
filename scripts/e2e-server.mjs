import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['dist/server/main.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: '4319',
    CODESIP_DB: ':memory:',
    CODESIP_SETUP_TOKEN: 'browser-test-setup-key',
    CODESIP_PUBLIC_URL: 'http://127.0.0.1:4319',
  },
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    child.kill();
    process.exit(0);
  });
child.on('exit', (code) => process.exit(code || 0));
