import { build as bundle } from 'esbuild';
import { build as buildWeb } from 'vite';
import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
await buildWeb();
await bundle({
  entryPoints: ['server/main.ts'],
  outfile: 'dist/server/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
});
const walk = async (dir) =>
  (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map(async (item) =>
        item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)],
      ),
    )
  ).flat();
const shellFiles = (await walk('dist/web'))
  .filter((file) => !file.endsWith('.map') && !file.endsWith('sw.js'))
  .sort();
const workerSource = await readFile('web/service-worker.js', 'utf8');
const versionHash = createHash('sha256').update(workerSource);
for (const file of shellFiles) {
  versionHash.update(path.relative('dist/web', file).replaceAll('\\', '/'));
  versionHash.update(await readFile(file));
}
const version = versionHash.digest('hex').slice(0, 12);
const index = await readFile('dist/web/index.html', 'utf8');
await writeFile(
  'dist/web/index.html',
  index.replace('<head>', `<head><meta name="codesip-version" content="${version}">`),
);
const assets = await Promise.all(
  shellFiles.map(async (file) => {
    const bytes = await readFile(file);
    return {
      url: '/' + path.relative('dist/web', file).replaceAll('\\', '/'),
      size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
  }),
);
await writeFile(
  'dist/web/sw.js',
  `const VERSION=${JSON.stringify(version)};const ASSETS=${JSON.stringify(assets)};\n` +
    workerSource,
);
await import('./build-plugin.mjs');
const { zipSync } = await import('fflate');
const entries = {};
for (const file of await walk('dist/obsidian/codesip-sync'))
  entries['codesip-sync/' + path.basename(file)] = new Uint8Array(await readFile(file));
await writeFile('dist/web/codesip-obsidian.zip', zipSync(entries));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const runtimeNames = [
  'fastify',
  '@fastify/cookie',
  '@fastify/rate-limit',
  '@fastify/multipart',
  '@fastify/static',
  'yauzl',
];
await mkdir('dist/release', { recursive: true });
await writeFile(
  'dist/release/package.json',
  JSON.stringify(
    {
      name: 'codesip-service',
      version: pkg.version,
      private: true,
      type: 'module',
      engines: { node: '>=24' },
      dependencies: Object.fromEntries(runtimeNames.map((n) => [n, pkg.dependencies[n]])),
    },
    null,
    2,
  ),
);
console.log('Built web reader, API and Obsidian plugin.');
