import { spawn } from 'node:child_process';
const run = (file, args) =>
  spawn(process.execPath, [file, ...args], { stdio: 'inherit', env: process.env });
const children = [
  run('node_modules/tsx/dist/cli.mjs', ['watch', 'server/main.ts']),
  run('node_modules/vite/bin/vite.js', ['--host', '127.0.0.1']),
];
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of children) child.kill();
    process.exit(0);
  });
