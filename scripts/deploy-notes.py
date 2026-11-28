import os
import sys
import base64
import subprocess
from pathlib import Path

vault_dir = Path("vault_export")
md_files = list(vault_dir.rglob("*.md"))

payload = {}
for file_path in md_files:
    rel_path = file_path.relative_to(vault_dir).as_posix()
    content = file_path.read_bytes()
    payload[rel_path] = base64.b64encode(content).decode('ascii')
    print(f"Loaded {rel_path}, size={len(content)} bytes")

remote_script = f"""import sqlite3
import hashlib
import base64
from datetime import datetime, timezone

DB_PATH = '/var/lib/codesip/codesip.sqlite'
LIBRARY_ID = '0c4f71da-1418-4951-b01d-4b0c33c34f9a'

payload = {repr(payload)}

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# Verify library exists
cursor.execute("SELECT id, name, kind, revision FROM libraries WHERE id=?", (LIBRARY_ID,))
row = cursor.fetchone()
if not row:
    print("Library not found!")
    exit(1)

print(f"Found library: id={{row[0]}}, name={{row[1]}}, kind={{row[2]}}, revision={{row[3]}}")

for rel_path, b64_data in payload.items():
    content = base64.b64decode(b64_data)
    h = hashlib.sha256(content).hexdigest()
    size = len(content)
    is_text = 1
    media_type = 'text/markdown; charset=utf-8'
    
    cursor.execute('''
        INSERT INTO files(library_id, path, hash, size, is_text, media_type, content)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(library_id, path) DO UPDATE SET
            hash=excluded.hash,
            size=excluded.size,
            is_text=excluded.is_text,
            media_type=excluded.media_type,
            content=excluded.content
    ''', (LIBRARY_ID, rel_path, h, size, is_text, media_type, content))
    print(f"Upserted file: {{rel_path}} ({{size}} bytes, hash={{h[:12]}}...)")

now_iso = datetime.now(timezone.utc).isoformat()
cursor.execute('''
    UPDATE libraries 
    SET revision = revision + 1, updated_at = ?
    WHERE id = ?
''', (now_iso, LIBRARY_ID))

conn.commit()

cursor.execute("SELECT count(*), coalesce(sum(size), 0) FROM files WHERE library_id=?", (LIBRARY_ID,))
count, total_bytes = cursor.fetchone()
print(f"Finished! Total files in library: {{count}}, total bytes: {{total_bytes}}")
cursor.execute("SELECT revision, updated_at FROM libraries WHERE id=?", (LIBRARY_ID,))
print("Updated library metadata:", cursor.fetchone())
conn.close()
"""

remote_script_path = Path("scripts/remote_insert.py")
remote_script_path.write_text(remote_script, encoding="utf-8")
print("Wrote scripts/remote_insert.py")

ssh_config = "D:/qiqi_me/HarmonyOS/server-private/ssh_config"
print("Uploading remote_insert.py via scp...")
subprocess.run(["scp", "-F", ssh_config, str(remote_script_path), "eternal-jade-lightsail:/tmp/remote_insert.py"], check=True)
print("Executing remote_insert.py on server...")
res = subprocess.run(["ssh", "-F", ssh_config, "eternal-jade-lightsail", "sudo python3 /tmp/remote_insert.py"], capture_output=True, text=True)
print("STDOUT:\n", res.stdout)
print("STDERR:\n", res.stderr)
if res.returncode != 0:
    print(f"Failed with exit code {res.returncode}")
    sys.exit(res.returncode)
