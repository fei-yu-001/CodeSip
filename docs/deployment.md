# CodeSip 独立部署

## 隔离约定

只复用宿主机和已有通配符证书。CodeSip 使用自己的系统用户、服务、数据库、配置、备份目录及 nginx 站点，不引用游戏的数据库、环境文件或账号。

`deploy/install.py` 在变更前后分别验证已有游戏健康接口，只读取状态。只在 nginx 配置测试通过后 reload，不 restart 游戏服务。失败时恢复 CodeSip 的旧发布链接和站点配置。

## 发布

1. 本地通过类型检查、集成测试、浏览器测试和构建。
2. `npm run release` 输出 `.local/codesip-release.tar.gz` 与首次部署的私有环境配置。
3. 按工作区私有服务器入口连接服务器，在权限为 700 的临时目录上传发布包、`deploy/install.py` 和环境文件。
4. 执行 `sudo python3 install.py codesip-release.tar.gz codesip.env`。已有环境文件会保留。
5. 校验 CodeSip HTTPS、原游戏健康、独立 SQLite 路径和会话 Cookie。
6. 清理上传用的临时环境文件；保留本地 `.local/first-login.md` 供本人首次设置账号。

`install.py` 依赖 Node.js 24+、nginx、Python 3.12+，以及可运行 systemd 的 Linux 主机。安装 npm 包时使用 CodeSip 专用用户，运行服务限制在 384 MB 内存和 50% 单核 CPU。

## 查看状态与备份

```sh
systemctl status codesip
journalctl -u codesip -n 50 --no-pager
sudo python3 /opt/harmonyos/services/codesip/current/deploy/backup.py
```

备份通过 SQLite 在线备份接口完成，输出到 `/var/backups/codesip`，不会直接复制正在写入的 WAL 数据库。当前未自动配置备份定时器。

## 回滚

先保留数据库备份，再把 `current` 链接指回 `releases/` 中已验证的旧版本，只重启 `codesip`。此版数据库没有破坏性迁移；今后存在迁移时应按迁移说明判断数据库与旧代码是否兼容。

## 初始访问

首次设置密钥不在 Git 或文档里发布。部署后使用本机 `.local/first-login.md` 中的值，打开 CodeSip 网页自己设置账号密码。账号建立后首次设置接口关闭。
