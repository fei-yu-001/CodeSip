import { spawn } from 'node:child_process';
// Isolate browser fixtures from the production login rate limit. All HTTP
// handlers are real; only the temporary in-memory test app disables throttling.
const source = `
  import { buildApp } from './server/app.ts';
  import path from 'node:path';
  const { app } = await buildApp({
    database: ':memory:', setupToken: 'browser-test-setup-key',
    publicUrl: 'http://127.0.0.1:4319', staticDir: path.resolve('dist/web'),
    rateLimit: false,
  });
  await app.listen({ host: '127.0.0.1', port: 4319 });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => { await app.close(); process.exit(0); });
`;
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--input-type=module', '--eval', source],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: '4319',
      CODESIP_DB: ':memory:',
      CODESIP_SETUP_TOKEN: 'browser-test-setup-key',
      CODESIP_PUBLIC_URL: 'http://127.0.0.1:4319',
    },
  },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    child.kill();
    process.exit(0);
  });
child.on('exit', (code) => process.exit(code || 0));
