import { startRust, buildRust, stopRust } from './rust.mjs';
if (process.argv.includes('--build')) buildRust();
const child = startRust();
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await stopRust(child);
    process.exit(0);
  });
child.once('exit', (code) => process.exit(code || 0));
