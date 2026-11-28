#!/usr/bin/env python3
"""Install only CodeSip paths; preserve the game service, database and configuration."""
import argparse, datetime, json, os, pathlib, pwd, shutil, subprocess, tarfile, urllib.request, time
ROOT=pathlib.Path('/opt/harmonyos/services/codesip')
CONFIG=pathlib.Path('/etc/codesip/codesip.env')
def run(args):
    result=subprocess.run(args,check=True,capture_output=True,text=True)
    return result.stdout.strip()
def health(url):
    with urllib.request.urlopen(url,timeout=12) as response:
        if response.status!=200: raise RuntimeError('Health check failed')
        return response.status
parser=argparse.ArgumentParser();parser.add_argument('archive');parser.add_argument('environment');args=parser.parse_args()
if os.geteuid()!=0: raise SystemExit('Run as root')
# Abort before mutation if the existing application is unhealthy.
health('https://jade.ddyu.online/api/health')
if ROOT.exists() and not ROOT.is_dir(): raise SystemExit('Unexpected CodeSip deployment path')
ROOT.mkdir(parents=True,exist_ok=True)
release=ROOT/'releases'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
release.mkdir(parents=True,exist_ok=False)
with tarfile.open(args.archive,'r:gz') as archive:
    for member in archive.getmembers():
        path=pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not member.isfile() and not member.isdir(): raise SystemExit('Unexpected archive entry')
    archive.extractall(release,filter='data')
try: pwd.getpwnam('codesip')
except KeyError: run(['useradd','--system','--no-create-home','--shell','/usr/sbin/nologin','codesip'])
# The native release needs no Node runtime or dependency installation.
binary=release/'dist/server/codesip-server'
if binary.read_bytes()[:6]!=b'\x7fELF\x02\x01': raise RuntimeError('Expected a Linux Rust executable')
binary.chmod(0o755)
CONFIG.parent.mkdir(mode=0o700,exist_ok=True)
if not CONFIG.exists():
    shutil.copyfile(args.environment,CONFIG);CONFIG.chmod(0o600)
unit=pathlib.Path('/etc/systemd/system/codesip.service');nginx=pathlib.Path('/etc/nginx/sites-available/codesip');enabled=pathlib.Path('/etc/nginx/sites-enabled/codesip');current=ROOT/'current'
previous_current=current.resolve() if current.is_symlink() else None
previous_unit=unit.read_bytes() if unit.exists() else None
previous_nginx=nginx.read_bytes() if nginx.exists() else None
was_enabled=enabled.is_symlink()
try:
    if current.exists() and not current.is_symlink(): raise RuntimeError('CodeSip current is not a release symlink')
    next_link=ROOT/'current.next'
    if next_link.is_symlink(): next_link.unlink()
    next_link.symlink_to(release);next_link.replace(current)
    shutil.copyfile(release/'deploy/codesip.service',unit)
    shutil.copyfile(release/'deploy/nginx.conf',nginx)
    if not enabled.exists(): enabled.symlink_to(nginx)
    run(['nginx','-t'])
    run(['systemctl','daemon-reload']);run(['systemctl','enable','codesip']);run(['systemctl','restart','codesip'])
    for attempt in range(15):
        try: health('http://127.0.0.1:4318/api/health');break
        except Exception:
            if attempt==14: raise
            time.sleep(1)
    run(['systemctl','reload','nginx'])
    health('https://codesip.ddyu.online/api/health');health('https://jade.ddyu.online/api/health')
except Exception:
    if previous_current:
        rollback=ROOT/'current.rollback';rollback.symlink_to(previous_current);rollback.replace(current)
    else: run(['systemctl','stop','codesip'])
    if previous_unit is not None: unit.write_bytes(previous_unit)
    if previous_nginx is not None: nginx.write_bytes(previous_nginx)
    elif nginx.exists(): nginx.unlink()
    if not was_enabled and enabled.is_symlink(): enabled.unlink()
    run(['systemctl','daemon-reload'])
    if previous_current: run(['systemctl','restart','codesip'])
    run(['nginx','-t']);run(['systemctl','reload','nginx']);raise
(ROOT/'DEPLOYMENT.md').write_text('# CodeSip\n\nDedicated service: codesip. Listener: 127.0.0.1:4318.\n\nDatabase: /var/lib/codesip/codesip.sqlite. Configuration: /etc/codesip/codesip.env.\n\nThis deployment must not modify the Eternal Jade Scroll service or database.\n\nPrevious releases remain under releases/ for rollback. Back up via current/deploy/backup.py.\n',encoding='utf-8')
print(json.dumps({'service':'codesip','release':release.name,'https_health':200,'game_health_before_and_after':200,'game_configuration_changed':False}))
