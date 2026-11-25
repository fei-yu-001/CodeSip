# CodeSip 独立部署

## 隔离约定

只复用宿主机和已有通配符证书。CodeSip 使用自己的系统用户、服务、数据库、配置、备份目录及 nginx 站点，不引用游戏的数据库、环境文件或账号。

`deploy/install.py` 在变更前后分别验证已有游戏健康接口，只读取状态。只在 nginx 配置测试通过后 reload，不 restart 游戏服务。失败时恢复 CodeSip 的旧发布链接和站点配置。

## 首次部署

1. 本地通过类型检查、集成测试、浏览器测试和构建。
2. `npm run release` 输出 `.local/codesip-release.tar.gz` 与首次部署的私有环境配置。
3. 按工作区私有服务器入口连接服务器，在权限为 700 的临时目录上传发布包、`deploy/install.py` 和环境文件。
4. 执行 `sudo python3 install.py codesip-release.tar.gz codesip.env`。已有环境文件会保留。
5. 校验 CodeSip HTTPS、原游戏健康、独立 SQLite 路径和会话 Cookie。
6. 清理上传用的临时环境文件；保留本地 `.local/first-login.md` 供本人首次设置账号。

`install.py` 依赖 Node.js 24+、nginx、Python 3.12+，以及可运行 systemd 的 Linux 主机。安装 npm 包时使用 CodeSip 专用用户，运行服务限制在 384 MB 内存和 50% 单核 CPU。

## 更新现有服务

已有 CodeSip 服务使用 `deploy/update.py`。此脚本只切换 CodeSip 的发布目录和重启 `codesip`，不会重写 nginx 配置或环境文件。

1. 完成类型、后台、构建与浏览器验证后，执行 `npm run release`，记录输出的 SHA-256。
2. 通过工作区私有服务器入口，将发布包与 `deploy/update.py` 上传到服务器专用临时目录，无需上传凭据。
3. 执行 `sudo python3 update.py codesip-release.tar.gz <SHA-256>`。
4. 脚本验证包校验值和文件范围，创建新的发布目录；锁文件一致时复用已安装依赖，否则以 CodeSip 用户安装生产依赖。
5. 在切换前通过 SQLite 在线备份接口备份并校验数据库；切换后验证本地 API、公开 HTTPS、批注表及现有游戏健康状态。若验证失败，恢复旧发布链接并重启 CodeSip。
6. 返回的发布标识、备份文件名和校验值同时保存在新发布目录的 `verification.json`，便于后续核对。

手机端通过既有 HTTPS 地址获取新版阅读器。联网重新打开应用后检查功能；不要通过清除应用数据来更新，以免丢失尚未同步的本机草稿。

## 查看状态与备份

```sh
systemctl status codesip
journalctl -u codesip -n 50 --no-pager
sudo python3 /opt/harmonyos/services/codesip/current/deploy/backup.py
```

备份通过 SQLite 在线备份接口完成，输出到 `/var/backups/codesip`，不会直接复制正在写入的 WAL 数据库。当前未自动配置备份定时器。

## 回滚

先保留数据库备份，再把 `current` 链接指回 `releases/` 中已验证的旧版本，只重启 `codesip`。2026-11-25 起，v1 同步的笔记、设备与附件表改为账号联合主键。启动时事务迁移并保留原有行、设备密钥和变更序号，普通文件库、批注与编辑版不受影响。迁移后应使用兼容联合主键的程序回滚；旧程序的单列 `ON CONFLICT` 不兼容新表。更新脚本检测到同步主键已变化时，会保留新发布与现有数据并报告验证错误，避免自动切回不兼容的旧程序；应发布兼容修复，不可直接用备份覆盖发布后的新数据。

## 初始访问

首次设置密钥不在 Git 或文档里发布。部署后使用本机 `.local/first-login.md` 中的值，打开 CodeSip 网页自己设置账号密码。账号建立后首次设置接口关闭。
