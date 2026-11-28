const CACHE = `codesip-shell-${VERSION}`;
const total = ASSETS.reduce((sum, asset) => sum + asset.size, 0);
const paths = new Set(ASSETS.map((asset) => asset.url));
let progress = { phase: 'ready', downloaded: total, total };
let lastReport = 0;
const message = () => ({ type: 'codesip:update', version: VERSION, ...progress });
async function report(force = false) {
  if (!force && Date.now() - lastReport < 100) return;
  lastReport = Date.now();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message());
}
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const existed = await caches.has(CACHE);
      const cache = await caches.open(CACHE);
      const abort = new AbortController();
      let cursor = 0;
      progress = { phase: 'downloading', downloaded: 0, total };
      await report(true);
      const download = async () => {
        while (cursor < ASSETS.length) {
          const asset = ASSETS[cursor++];
          const timeout = setTimeout(() => abort.abort(), 45000);
          try {
            const response = await fetch(asset.url, { cache: 'no-store', signal: abort.signal });
            if (!response.ok || response.redirected) throw new Error('Asset download failed');
            const reader = response.body?.getReader();
            const chunks = [];
            let size = 0;
            if (reader) {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                size += value.byteLength;
                progress.downloaded += value.byteLength;
                void report();
              }
            } else {
              const value = new Uint8Array(await response.arrayBuffer());
              chunks.push(value);
              size = value.byteLength;
              progress.downloaded += size;
              void report();
            }
            if (size !== asset.size) throw new Error('Asset size mismatch');
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
            if (hash !== asset.hash) throw new Error('Asset checksum mismatch');
            // A newly constructed response contains decoded bytes, not HTTP-compressed bytes.
            const headers = new Headers(response.headers);
            headers.delete('content-encoding');
            headers.set('content-length', String(size));
            await cache.put(asset.url, new Response(bytes, { headers }));
          } catch (error) {
            abort.abort();
            throw error;
          } finally {
            clearTimeout(timeout);
          }
        }
      };
      const results = await Promise.allSettled(Array.from({ length: 4 }, download));
      if (results.some((result) => result.status === 'rejected')) {
        if (!existed) await caches.delete(CACHE);
        progress.phase = 'error';
        await report(true);
        throw new Error('CodeSip update incomplete; previous version retained');
      }
      progress = { phase: 'ready', downloaded: total, total };
      await report(true);
      // Updates wait for the reader's explicit reload. First installation is silent.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CODESIP_UPDATE_STATUS') event.source?.postMessage(message());
  if (event.data?.type === 'CODESIP_APPLY_UPDATE') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'CODESIP_CLIENT_READY' && event.data.version === VERSION) {
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // An older open tab may still need its lazy-loaded assets. Prune only once
        // this version is the sole open reader; never touch private/offline data.
        if (clients.length !== 1 || clients[0].id !== event.source?.id) return;
        if (self.registration.installing || self.registration.waiting) return;
        const keys = await caches.keys();
        const previous = keys.slice(0, Math.max(0, keys.indexOf(CACHE)));
        await Promise.all(
          previous
            .filter((key) => key.startsWith('codesip-shell-') && key !== CACHE)
            .map((key) => caches.delete(key)),
        );
      })(),
    );
  }
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (event.request.mode === 'navigate') {
    // Keep this page and its assets on one complete version until activation.
    event.respondWith(
      caches
        .open(CACHE)
        .then(async (cache) => (await cache.match('/index.html')) || fetch(event.request)),
    );
  } else if (paths.has(url.pathname) || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) =>
            (await cache.match(event.request)) ||
            (await caches.match(event.request)) ||
            fetch(event.request),
        ),
    );
  }
});
