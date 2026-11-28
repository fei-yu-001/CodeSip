import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../../server/store';
import { buildApp as buildLegacy, type AppOptions } from '../../server/app';
// JS owns process lifecycle; every request is served by the actual Rust binary.
// @ts-expect-error build scripts intentionally have no TypeScript declaration
import { startRust, readyRust, stopRust } from '../../scripts/rust.mjs';

export async function buildApp(
  options: AppOptions,
): Promise<Awaited<ReturnType<typeof buildLegacy>>> {
  if (process.env.CODESIP_TEST_BACKEND === 'node') return buildLegacy(options);
  const base = path.resolve('.local');
  mkdirSync(base, { recursive: true });
  const temporary = mkdtempSync(path.join(base, 'rust-api-test-'));
  if (path.dirname(path.resolve(temporary)) !== base) throw new Error('Unexpected test directory');
  const database =
    options.database === ':memory:' ? path.join(temporary, 'fixture.sqlite') : options.database;
  const store = new Store(database);
  const child = startRust({
    HOST: '127.0.0.1',
    PORT: '0',
    CODESIP_DB: database,
    CODESIP_SETUP_TOKEN: options.setupToken,
    CODESIP_PUBLIC_URL: options.publicUrl || 'http://127.0.0.1:4318',
    CODESIP_STATIC_DIR: options.staticDir || path.join(temporary, 'no-static'),
    CODESIP_RATE_LIMIT: options.rateLimit === false ? 'off' : 'on',
    NODE_ENV: options.production ? 'production' : 'test',
  });
  let address: string;
  try {
    address = await readyRust(child);
  } catch (error) {
    store.db.close();
    await stopRust(child);
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  const app = {
    async ready() {},
    async close() {
      if (closed) return;
      closed = true;
      await stopRust(child);
      store.db.close();
      if (path.dirname(path.resolve(temporary)) !== base)
        throw new Error('Unexpected test directory');
      rmSync(temporary, { recursive: true, force: true });
    },
    async inject(options: any) {
      const payload = options.payload;
      const headers = { ...options.headers };
      let bytes: Buffer | undefined;
      if (payload !== undefined) {
        bytes = Buffer.isBuffer(payload)
          ? payload
          : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
        if (!headers['content-type']) headers['content-type'] = 'application/json';
        headers['content-length'] = bytes.length;
      }
      return new Promise((resolve, reject) => {
        const req = request(
          new URL(options.url || '/', address),
          { method: options.method || 'GET', headers },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
              const rawPayload = Buffer.concat(chunks);
              const body = rawPayload.toString();
              resolve({
                statusCode: response.statusCode,
                headers: response.headers,
                rawPayload,
                body,
                json: () => JSON.parse(body),
                cookies: (response.headers['set-cookie'] || []).map((cookie) => {
                  const [first] = cookie.split(';');
                  const split = first.indexOf('=');
                  return { name: first.slice(0, split), value: first.slice(split + 1) };
                }),
              });
            });
            response.on('error', reject);
          },
        );
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('Rust test request timeout')));
        req.end(bytes);
      });
    },
  };
  return { app, store } as unknown as Awaited<ReturnType<typeof buildLegacy>>;
}
