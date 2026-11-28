import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Only mounted by the local browser-test server. Serve the real worker with a
// controlled release and a streamed synthetic asset, without mocking SW APIs.
export async function installUpdateFixtures(app, pagePolicy) {
  const builtWorker = await readFile('dist/web/sw.js', 'utf8');
  const index = await readFile('dist/web/index.html', 'utf8');
  const prefix = builtWorker.slice(0, builtWorker.indexOf('\n'));
  const baseVersion = JSON.parse(prefix.match(/^const VERSION=("[a-f0-9]+")/)[1]);
  const assets = JSON.parse(prefix.match(/const ASSETS=(\[.*\]);$/)[1]);
  const source = builtWorker.slice(builtWorker.indexOf('\n') + 1);
  const payload = Buffer.alloc(2 * 1024 * 1024, 79);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  let release = {
    version: baseVersion,
    failure: '',
    slow: false,
    legacy: false,
    legacyPolicy: false,
  };
  const page = () => index.replace(`content="${baseVersion}"`, `content="${release.version}"`);
  app.post('/__test/update-control', (request) => {
    const body = request.body || {};
    release = {
      version: /^[a-f0-9]{12}$/.test(body.version) ? body.version : baseVersion,
      failure: body.failure || '',
      slow: !!body.slow,
      legacy: !!body.legacy,
      legacyPolicy: !!body.legacyPolicy,
    };
    return { baseVersion, version: release.version };
  });
  app.get('/sw.js', (request, reply) => {
    reply.type('application/javascript').header('Cache-Control', 'no-store');
    if (release.legacy) {
      return `const CACHE='codesip-shell-legacy-fixture';const ASSETS=${JSON.stringify(assets.map((asset) => asset.url))};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('codesip-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
  else if (ASSETS.includes(url.pathname)) event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request)));
});`;
    }
    if (release.version === baseVersion) return builtWorker;
    const content = Buffer.from(page());
    const nextAssets = assets.map((asset) =>
      asset.url === '/index.html' ? { ...asset, size: content.length, hash: hash(content) } : asset,
    );
    nextAssets.push({
      url: '/__test/update-payload.bin',
      size: payload.length,
      hash: hash(payload),
    });
    return `const VERSION=${JSON.stringify(release.version)};const ASSETS=${JSON.stringify(nextAssets)};\n${source}`;
  });
  for (const route of ['/', '/index.html'])
    app.get(route, (request, reply) =>
      reply
        .type('text/html')
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Security-Policy',
          release.legacyPolicy
            ? pagePolicy.replace(/connect-src[^;]*;/, "connect-src 'self';")
            : pagePolicy,
        )
        .send(page()),
    );
  app.get('/__test/update-payload.bin', async (request, reply) => {
    const { failure, slow } = release;
    if (failure === 'network') return reply.code(503).send('Synthetic unavailable asset');
    if (failure === 'corrupt')
      return reply.type('application/octet-stream').send(Buffer.alloc(payload.length, 80));
    if (!slow) return reply.type('application/octet-stream').send(payload);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
    });
    for (let offset = 0; offset < payload.length && !reply.raw.destroyed; offset += 65536) {
      reply.raw.write(payload.subarray(offset, offset + 65536));
      await delay(70);
    }
    reply.raw.end();
  });
}
