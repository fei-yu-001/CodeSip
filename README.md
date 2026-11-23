# CodeSip · 饭后溜溜码

把代码和学习笔记装进口袋。电脑整理，手机慢慢读。

CodeSip 是一个自托管的只读阅读器，包含手机与桌面适配的 Web/PWA 客户端、独立 Node.js 后台、Obsidian 桌面同步插件，以及 HarmonyOS ArkWeb 应用工程。此项目与 Eternal Jade Scroll 游戏的服务、数据库、账号及发布目录完全独立。

## 当前可用

- 私人账号：首次设置密钥保护的账号初始化、登录、退出、服务端会话。
- 代码项目：ZIP 导入、目录树、按路径筛选、语法高亮、代码折叠、自动换行、全文搜索与跳转到行。
- 学习笔记：Markdown、表格、任务列表、代码块高亮、同步图片、基础 `[[双链]]` 和 `![[图片]]`。
- 手机阅读：响应式目录抽屉、浅色/深色/羊皮纸主题、阅读位置恢复、Markdown 标题定位、完整项目离线下载、离线搜索。
- 应用更新：真实下载进度、失败重试、稍后重载与未保存批注保护，支持账号弹窗主动检查。[更新与同步说明](docs/app-updates.md)。
- 阅读批注：独立保存于 SQLite，按账号、库和文件隔离，支持编辑、删除与多设备版本冲突检查，不修改原文。接口与存储边界见 [批注说明](docs/annotations.md)。
- Obsidian：选择目录后手动或自动上传，按内容哈希增量同步，附件先行，处理改名、删除、冲突和失败重试；每个连接只授权一个笔记库，可轮换和撤销。
- 液态玻璃：暖纸色正文、深海色场景、悬浮胶囊导航、SVG 边缘位移折射、点击回弹、导航拖动、减少动态/透明度适配。兼容环境使用磨砂降级。
- 部署：独立 systemd 服务、HTTPS 反向代理、持久化 SQLite、限额、发布回滚和数据库备份脚本。

「符号速览」目前是按文本提取的函数/类等声明，尚不是语言服务器或完整语义分析。跨文件定义跳转、引用分析、依赖图和多标签属于后续工作。

## 快速运行

需要 Node.js 24+ 与 npm。

```powershell
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`。本地首次设置密钥为 `codesip-local-development-only`，随后自行创建账号和密码。这个开发密钥只用于本地开发，生产环境必须提供独立的 `CODESIP_SETUP_TOKEN`。

```powershell
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

构建产物：

| 产物 | 位置 |
| --- | --- |
| Web/PWA 阅读器 | `dist/web/` |
| 后台 | `dist/server/main.mjs` |
| Obsidian 插件 | `dist/obsidian/codesip-sync/` |
| 插件 ZIP | `dist/web/codesip-obsidian.zip` |
| 鸿蒙工程 | `harmony/` |

生产运行：配置下方环境变量，再执行 `npm start`。源码不会被执行，HTML 也以文本处理。

## 自托管配置

| 环境变量 | 作用 |
| --- | --- |
| `NODE_ENV=production` | 启用安全 Cookie，禁止开发设置密钥回退 |
| `CODESIP_SETUP_TOKEN` | 首次设置密钥，至少 16 字符；初始化后不能再次注册 |
| `CODESIP_PUBLIC_URL` | 公开 HTTPS 源，用于校验浏览器写请求来源 |
| `CODESIP_DB` | 独立 SQLite 数据库路径 |
| `HOST` / `PORT` | 默认 `127.0.0.1:4318` |

本仓库的 `deploy/` 配置针对现有服务器布局，只操作 CodeSip 的命名空间：

- 服务：`codesip.service`
- 程序：`/opt/harmonyos/services/codesip`
- 数据：`/var/lib/codesip/codesip.sqlite`
- 配置：`/etc/codesip/codesip.env`
- nginx：仅 `sites-available/codesip` 和相应链接
- 备份：`/var/backups/codesip`

构建后执行 `npm run release` 生成 `.local/codesip-release.tar.gz`。首次设置资料也仅保存到忽略目录 `.local/`；生产数据和密钥不进入仓库。部署详见 [部署说明](docs/deployment.md)。

## 连接 Obsidian

1. 在 CodeSip 的「学习笔记」选择「连接 Obsidian」，创建笔记库并生成连接信息。
2. 下载插件 ZIP，将解压的 `codesip-sync` 目录放到电脑笔记库的 `.obsidian/plugins/`。
3. 在 Obsidian 设置中启用该社区插件，把连接信息粘贴到 CodeSip Sync 设置并保存。
4. 选择同步目录，点击「同步到 CodeSip」。确认内容正确后开启自动同步。
5. 手机登录同一个 CodeSip 账号，打开笔记库；需要离线时点击「保存离线」。

桌面快捷方式只负责启动 Obsidian；同步来源是当前打开的笔记库文件夹。「同步目录」留空表示整个库中的笔记和允许的附件。手机刷新只读取已上传的服务端副本，阅读批注不回写电脑笔记正文。

插件使用绑定笔记库的专用凭据，与网页登录属于同一账号，无须把账号密码长期保存到插件。Obsidian 运行时自动上传，关闭后暂停；已上传内容仍可从手机访问。同步范围固定在首次成功同步时，换目录请创建新的目标笔记库，防止把其他目录的数据误删。

## 兼容范围与限制

- 首版是私人单账号服务；公开注册、多账号管理和密码找回尚未提供。
- ZIP 最大 24 MB，单文件 8 MB，单库解压后 64 MB / 4000 文件，账号总存储 512 MB，最多 60 个库。
- 文本预览支持不超过 2 MB 的 UTF-8 文件；其他编码、大型二进制文件的预览需要后续适配。
- 笔记支持基础 Wikilink 文件跳转；标题/块定位、笔记嵌入、Canvas、Dataview、公式和 Mermaid 渲染尚未实现。
- 外链图片不会自动下载。笔记库中同步的图片可随项目保存离线。
- 离线副本按账号隔离保存在设备浏览器中，退出登录会清除本机缓存。尚未实现端到端加密；服务器管理员能访问数据库。
- HarmonyOS 客户端 0.1.2 已签名并安装到连接的真机（2026-11-23 核实）。阅读器更新由同一 HTTPS 服务提供；原生文件导入、分享和各系统版本的 ArkWeb 离线表现仍需分别验证。
- 浏览器测试当前覆盖 Chromium 的桌面和手机尺寸。Safari/Firefox 使用磨砂降级，未做实机验证。

## 验证记录

实际构建、测试、部署结果及尚未完成的验证见 [验收记录](docs/verification.md)。液态玻璃的设计与兼容策略见 [设计说明](docs/liquid-glass.md)。

## 目录

```text
server/      后台、存储、ZIP 导入
shared/      前后端数据类型
web/         React 阅读器、离线缓存、玻璃材质
plugin/      Obsidian 桌面同步插件
harmony/     鸿蒙 ArkTS/ArkWeb 工程
deploy/      独立部署与备份脚本
tests/       后台、插件和浏览器测试
docs/        设计、部署及验收记录
```

许可证沿用仓库的 GPL-3.0。玻璃边缘折射代码为本项目自行实现，依赖库遵循各自许可证。
