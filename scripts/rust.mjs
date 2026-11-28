import { existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export const binaryName = 'codesip-server' + (process.platform === 'win32' ? '.exe' : '');
export const binaryPath = path.resolve(
  process.env.CODESIP_SERVER_BINARY || `server-rust/target/release/${binaryName}`,
);
export function cargoEnvironment() {
  const env = { ...process.env };
  const extension = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    env.CARGO,
    env.CARGO_HOME && path.join(env.CARGO_HOME, 'bin', 'cargo' + extension),
    path.join(os.homedir(), '.cargo/bin/cargo' + extension),
  ];
  if (process.platform === 'win32') candidates.push('D:/ruangong/rust/cargo/bin/cargo.exe');
  const cargo = candidates.find((p) => p && existsSync(p)) || 'cargo';
  if (path.isAbsolute(cargo)) {
    const home = path.dirname(path.dirname(cargo));
    env.CARGO_HOME ||= home;
    const rustup = path.resolve(home, '../rustup');
    if (existsSync(rustup)) env.RUSTUP_HOME ||= rustup;
    env.PATH = path.dirname(cargo) + path.delimiter + (env.PATH || '');
  }
  return { cargo, env };
}
export function buildRust(extra = []) {
  const { cargo, env } = cargoEnvironment();
  const result = spawnSync(
    cargo,
    ['build', '--release', '--locked', '--manifest-path', 'server-rust/Cargo.toml', ...extra],
    { env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Rust build failed');
}
export function startRust(env = {}) {
  if (!existsSync(binaryPath))
    throw new Error('Build the Rust service first: npm run build:server');
  return spawn(binaryPath, [], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function readyRust(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Rust server startup timeout'));
    }, 30000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Rust server exited: ${code}`));
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
      const address = output.match(/CodeSip Rust listening on (127\.0\.0\.1:\d+)/);
      if (address) {
        clearTimeout(timeout);
        resolve(`http://${address[1]}`);
      }
    });
  });
}
export async function stopRust(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}
