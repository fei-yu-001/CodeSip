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
const assets = (await walk('dist/web'))
  .map((f) => '/' + path.relative('dist/web', f).replaceAll('\\', '/'))
  .filter((f) => !f.endsWith('.map') && f != '/sw.js');
const version = createHash('sha256')
  .update(JSON.stringify(assets) + (await readFile('dist/web/index.html', 'utf8')))
  .digest('hex')
  .slice(0, 12);
await writeFile(
  'dist/web/sw.js',
  `const CACHE='codesip-shell-${version}';const ASSETS=${JSON.stringify(assets)};\n` +
    (await readFile('web/service-worker.js', 'utf8')),
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
