#!/usr/bin/env python3
"""Update an existing CodeSip release only; no nginx or other service changes."""
import hashlib, json, os, pathlib, sqlite3, subprocess, tarfile, time, urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path('/opt/harmonyos/services/codesip')
DATABASE = pathlib.Path('/var/lib/codesip/codesip.sqlite')

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout.strip()

def health(url):
    with urllib.request.urlopen(url, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError('Health check failed')
        return json.load(response)

def sync_primary_keys(database):
    with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as db:
        return {table: [(row[1], row[5]) for row in db.execute('PRAGMA table_info(' + table + ')') if row[5]]
                for table in ('user_devices', 'server_notes', 'server_assets')}

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('sha256')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Root required')
    archive = pathlib.Path(args.archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != args.sha256:
        raise RuntimeError('Archive checksum mismatch')
    current = ROOT / 'current'
    if not current.is_symlink():
        raise RuntimeError('Expected an existing CodeSip release link')
    previous = current.resolve(strict=True)
    if previous.parent != ROOT / 'releases':
        raise RuntimeError('Previous release is outside CodeSip releases')
    if health('https://codesip.ddyu.online/api/health').get('app') != 'codesip':
        raise RuntimeError('Unexpected CodeSip service')
    health('https://jade.ddyu.online/api/health')
    release_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    release = ROOT / 'releases' / release_id
    release.mkdir(mode=0o755)
    with tarfile.open(archive, 'r:gz') as package:
        for member in package.getmembers():
            item = pathlib.PurePosixPath(member.name)
            if item.is_absolute() or '..' in item.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('Invalid archive member')
            if item.parts[0] not in ('dist', 'deploy', 'package.json', 'package-lock.json', 'LICENSE'):
                raise RuntimeError('Unexpected release content')
        package.extractall(release, filter='data')
    if (previous / 'package-lock.json').read_bytes() == (release / 'package-lock.json').read_bytes() and (previous / 'node_modules').is_dir():
        (release / 'node_modules').symlink_to(previous / 'node_modules', target_is_directory=True)
    else:
        run(['chown', '-R', 'codesip:codesip', str(release)])
        run(['runuser', '-u', 'codesip', '--', 'env', 'npm_config_cache=/tmp/codesip-npm-cache', 'npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], cwd=release)
        run(['chown', '-R', 'root:root', str(release)])
    backup_dir = pathlib.Path('/var/backups/codesip')
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    backup_dir.chmod(0o700)
    backup = backup_dir / ('codesip-before-' + release_id + '.sqlite')
    os.close(os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    with sqlite3.connect('file:' + str(DATABASE) + '?mode=ro', uri=True) as src, sqlite3.connect(backup) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('Backup verification failed')
    backup.chmod(0o600)
    pending = ROOT / ('current-' + release_id)
    pending.symlink_to(release)
    pending.replace(current)
    try:
        run(['systemctl', 'restart', 'codesip'])
        for attempt in range(20):
            try:
                if health('http://127.0.0.1:4318/api/health').get('app') != 'codesip':
                    raise RuntimeError('Unexpected service')
                break
            except Exception:
                if attempt == 19:
                    raise
                time.sleep(1)
        health('https://codesip.ddyu.online/api/health')
        health('https://jade.ddyu.online/api/health')
        with sqlite3.connect('file:' + str(DATABASE) + '?mode=ro', uri=True) as db:
            for table in ('reader_annotations', 'reader_document_copies'):
                if not db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                    raise RuntimeError('Reader table not initialized: ' + table)
    except Exception as error:
        if sync_primary_keys(DATABASE) != sync_primary_keys(backup):
            raise RuntimeError('CodeSip verification failed after a sync schema migration. '
                               'Kept the new release and all current data; the previous program is not schema-compatible. '
                               'Deploy a compatible fix; do not overwrite new data with the backup.') from error
        rollback = ROOT / ('rollback-' + release_id)
        rollback.symlink_to(previous)
        rollback.replace(current)
        run(['systemctl', 'restart', 'codesip'])
        raise
    result = {'release': release_id, 'previous': previous.name, 'sha256': args.sha256, 'backup': backup.name, 'codesip_health': 200, 'game_health_before_and_after': 200, 'nginx_changed': False}
    (release / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))

if __name__ == '__main__':
    main()
