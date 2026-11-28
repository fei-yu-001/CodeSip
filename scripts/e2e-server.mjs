import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { startRust, readyRust, stopRust } from './rust.mjs';
import { installUpdateFixtures } from './e2e-updates.mjs';

// The small proxy provides synthetic service-worker update fixtures only.
// Every API request, authentication check and database write runs in Rust.
const temporary = await mkdtemp(path.resolve('.local/rust-browser-'));
const child = startRust({
  HOST: '127.0.0.1',
  PORT: '0',
  NODE_ENV: 'test',
  CODESIP_DB: path.join(temporary, 'browser.sqlite'),
  CODESIP_SETUP_TOKEN: 'browser-test-setup-key',
  CODESIP_PUBLIC_URL: 'http://127.0.0.1:4319',
  CODESIP_RATE_LIMIT: 'off',
});
const address = await readyRust(child);
const app = Fastify({ bodyLimit: 25 * 1024 * 1024 });
await installUpdateFixtures(app);
// Preserve raw multipart and JSON bytes for the real API.
app.register(async (proxy) => {
  proxy.removeAllContentTypeParsers();
  proxy.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );
  proxy.setNotFoundHandler((request, reply) => {
    reply.hijack();
    const headers = { ...request.headers, host: new URL(address).host };
    const upstream = httpRequest(
      new URL(request.url, address),
      { method: request.method, headers },
      (response) => {
        reply.raw.writeHead(response.statusCode, response.headers);
        response.pipe(reply.raw);
      },
    );
    upstream.on('error', () => {
      if (!reply.raw.headersSent) reply.raw.writeHead(502);
      reply.raw.end();
    });
    upstream.end(request.body || undefined);
  });
});
await app.listen({ host: '127.0.0.1', port: 4319 });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await stopRust(child);
  if (path.dirname(temporary) !== path.resolve('.local'))
    throw new Error('Unexpected fixture directory');
  await rm(temporary, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await stop();
    process.exit(0);
  });
child.once('exit', () => {
  if (!stopping) process.exit(1);
});
