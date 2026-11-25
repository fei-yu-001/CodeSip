#!/usr/bin/env python3
"""Update an existing CodeSip release only; no nginx or other service changes."""
import hashlib, json, os, pathlib, sqlite3, subprocess, tarfile, time, urllib.request, shutil, tempfile, pwd
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
    binary = release / 'dist/server/codesip-server'
    if binary.read_bytes()[:6] != b'\x7fELF\x02\x01':
        raise RuntimeError('Expected a Linux x86_64 Rust service')
    binary.chmod(0o755)
    unit = pathlib.Path('/etc/systemd/system/codesip.service')
    previous_unit = unit.read_bytes()
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
    # Exercise the native executable against an online backup before switching.
    # Validation mutates only this private copy; no credentials enter arguments.
    owner = pwd.getpwnam('codesip')
    with tempfile.TemporaryDirectory(prefix='validation-', dir=DATABASE.parent) as temporary:
        work = pathlib.Path(temporary)
        os.chown(work, owner.pw_uid, owner.pw_gid)
        fixture = work / 'candidate.sqlite'
        shutil.copyfile(backup, fixture)
        fixture.chmod(0o600)
        os.chown(fixture, owner.pw_uid, owner.pw_gid)
        checked = json.loads(run(['runuser', '-u', 'codesip', '--', str(binary), '--check-database', str(fixture)]))
        if checked.get('runtime') != 'rust' or checked.get('status') != 'ok':
            raise RuntimeError('Native database validation failed')
    pending = ROOT / ('current-' + release_id)
    pending.symlink_to(release)
    pending.replace(current)
    try:
        shutil.copyfile(release / 'deploy/codesip.service', unit)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'restart', 'codesip'])
        for attempt in range(20):
            try:
                if health('http://127.0.0.1:4318/api/health').get('runtime') != 'rust':
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
        unit.write_bytes(previous_unit)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'restart', 'codesip'])
        health('https://codesip.ddyu.online/api/health')
        health('https://jade.ddyu.online/api/health')
        raise
    result = {'release': release_id, 'previous': previous.name, 'sha256': args.sha256, 'backup': backup.name, 'codesip_health': 200, 'game_health_before_and_after': 200, 'nginx_changed': False, 'runtime': 'rust', 'native_database_validation': 'ok', 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
    (release / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))

if __name__ == '__main__':
    main()
