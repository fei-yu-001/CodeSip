import { spawn } from 'node:child_process';
import { cargoEnvironment } from './rust.mjs';
const { cargo, env } = cargoEnvironment();
const args = process.argv.slice(2);
const command = args.shift() || 'check';
const result = spawn(cargo, [command, '--manifest-path', 'server-rust/Cargo.toml', ...args], {
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => result.kill());
result.once('exit', (code) => process.exit(code || 0));
