import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/obsidian/codesip-sync', { recursive: true });
await build({
  entryPoints: ['plugin/src/main.ts'],
  outfile: 'dist/obsidian/codesip-sync/main.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian', 'electron', 'crypto'],
  minify: true,
});
await copyFile('plugin/manifest.json', 'dist/obsidian/codesip-sync/manifest.json');
await copyFile('plugin/styles.css', 'dist/obsidian/codesip-sync/styles.css');
