import { spawnSync } from 'node:child_process';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
await mkdir('.local', { recursive: true });
const result = spawnSync('python', ['scripts/package-release.py'], { stdio: 'inherit' });
if (result.status) process.exit(result.status);
