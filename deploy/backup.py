#!/usr/bin/env python3
import datetime, pathlib, sqlite3
source=pathlib.Path('/var/lib/codesip/codesip.sqlite')
if not source.is_file(): raise SystemExit('CodeSip database is missing')
folder=pathlib.Path('/var/backups/codesip');folder.mkdir(mode=0o700,parents=True,exist_ok=True)
target=folder/('codesip-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.sqlite')
with sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True) as src,sqlite3.connect(target) as dst: src.backup(dst)
target.chmod(0o600)
print('CodeSip database backup completed: '+target.name)
