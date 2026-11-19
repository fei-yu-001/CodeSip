import { buildApp } from './app';
import path from 'node:path';
const production = process.env.NODE_ENV === 'production';
const app = (
  await buildApp({
    database: process.env.CODESIP_DB || path.resolve('.local/codesip.sqlite'),
    setupToken:
      process.env.CODESIP_SETUP_TOKEN || (production ? '' : 'codesip-local-development-only'),
    publicUrl: process.env.CODESIP_PUBLIC_URL || 'http://127.0.0.1:4318',
    production,
    logger: true,
    staticDir: path.resolve('dist/web'),
  })
).app;
await app.listen({ port: Number(process.env.PORT || 4318), host: process.env.HOST || '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
