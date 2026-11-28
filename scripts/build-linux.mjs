import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cargoEnvironment } from './rust.mjs';
const { cargo, env } = cargoEnvironment();
// Optional local Windows tool installation; normal PATH works on other hosts.
if (process.platform === 'win32' && existsSync('D:/ruangong/rust/cross')) {
  env.PATH = [
    'D:/ruangong/rust/cross/Scripts',
    'D:/ruangong/rust/cross/Lib/site-packages/ziglang',
    env.PATH,
  ].join(path.delimiter);
  env.ZIG_GLOBAL_CACHE_DIR ||= 'D:/ruangong/rust/zig-cache';
}
const result = spawnSync(
  cargo,
  [
    'zigbuild',
    '--release',
    '--locked',
    '--target',
    'x86_64-unknown-linux-musl',
    '--manifest-path',
    'server-rust/Cargo.toml',
  ],
  { env, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status || 0);
