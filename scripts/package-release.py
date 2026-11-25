from pathlib import Path
import tarfile,json,hashlib,secrets,os
root=Path(__file__).resolve().parent.parent
out=root/'.local';out.mkdir(exist_ok=True)
archive=out/'codesip-release.tar.gz'
binary=Path(os.environ.get('CODESIP_LINUX_BINARY',str(root/'server-rust/target/x86_64-unknown-linux-musl/release/codesip-server')))
header=binary.read_bytes()[:20]
if header[:6]!=b'\x7fELF\x02\x01' or header[18:20]!=b'\x3e\x00':
    raise RuntimeError('A verified Linux x86_64 Rust binary is required for release')
with tarfile.open(archive,'w:gz') as tar:
    for name in ['package.json','package-lock.json','LICENSE','deploy']:
        tar.add(root/name,arcname=name)
    tar.add(root/'dist/web',arcname='dist/web')
    info=tar.gettarinfo(str(binary),arcname='dist/server/codesip-server')
    info.mode=0o755
    with binary.open('rb') as content: tar.addfile(info,content)
config=out/'codesip.env'
if not config.exists():
    key=secrets.token_urlsafe(32)
    config.write_text('HOST=127.0.0.1\nPORT=4318\nCODESIP_DB=/var/lib/codesip/codesip.sqlite\nCODESIP_PUBLIC_URL=https://codesip.ddyu.online\nCODESIP_SETUP_TOKEN='+key+'\n',encoding='utf-8')
    (out/'first-login.md').write_text('# CodeSip 首次登录\n\n地址：https://codesip.ddyu.online\n\n首次设置密钥：`'+key+'`\n\n打开网页，自己设置账号和密码。只有首次创建账号需要上面的密钥。电脑和手机之后使用同一个账号登录。请勿上传或分享此文件。\n',encoding='utf-8')
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'credentials':'stored only in ignored .local files'},ensure_ascii=False))
