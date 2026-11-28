# CodeSip 数据与功能边界调整（2026-11-28）

原先 `api.ts` 同时负责 HTTP、IndexedDB、账号清理、项目下载和格式化；`localSync.ts` 在一个循环中依次读取目录、上传批注、上传编辑版并下载文件。任何阶段抛错都会中断后续项目。应用更新依赖各组件分散监听同一个事件，只能显示固定的总提示；七七面板也直接维护请求控制器和历史写入。

这版按职责拆分，并为同步建立明确的部分失败结果。没有更换数据库或浏览器缓存键，没有迁移用户数据。

| 边界           | 实现                                                  | 职责                                                      |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| 网络           | `web/src/data/http.ts`                                | 请求、超时、HTTP 错误和取消；在响应解析后再次确认请求有效 |
| 账号生命周期   | `web/src/data/session.ts`                             | generation、退出时取消、各功能清理注册                    |
| 本机缓存       | `web/src/data/localCache.ts`                          | 原有 IndexedDB 的读写与事务                               |
| 文件仓库       | `web/src/data/libraryRepository.ts`                   | 哈希校验、下载、离线目录和删除缓存                        |
| 清理           | `web/src/data/privateData.ts`                         | 账号退出后的缓存与本机数据清理                            |
| 同步调度       | `web/src/sync/librarySync.ts`                         | 注入端口、按项目/阶段归集结果、部分失败隔离               |
| 浏览器同步适配 | `web/src/localSync.ts`                                | 把本机存储、请求和已有批注/编辑版 store 连接到调度器      |
| 同步界面       | `web/src/useLibrarySync.ts`、`LibrarySyncStatus.tsx`  | 取消、进度、结果、重试以及账号切换和卸载清理              |
| 更新保护       | `web/src/updateGuards.ts`、`useUpdateGuard.ts`        | 功能自行声明原因；更新器消费原因并兼容原事件              |
| 七七           | `QiqiPanel.tsx`、`QiqiSettings.tsx`、`useQiqiChat.ts` | 界面、设置草稿与对话请求/历史分开                         |

`api.ts` 暂时保留兼容 re-export；生产模块已经按用途导入具体边界。格式化函数独立为 `format.ts`。阅读路径不导入同步调度器；七七不调用项目同步，也不依赖更新器的 Service Worker 状态。

## 同步行为

- 批注、编辑版、远端阅读状态和文件阶段分别记录错误。一个项目下载失败后，后续项目继续。
- 目录读取失败仍允许上传独立的批注/编辑版。401、账号变化与取消会立即停止后续工作。
- 文件失败保留旧项目 revision；文件下载成功后才发布新目录。App 仅刷新成功发布目录的当前项目，失败时不重载阅读器。
- 部分失败不写完整同步时间，界面保留失败的项目、阶段和原因；「重试未完成项目」只处理这些项目。
- 取消信号贯通批注、编辑版、冲突恢复读取和文件下载。已发出的写请求可能已经被服务端接受，因此本机仍保留不确定写入标记；重试继续使用原版本/冲突流程。
- 更新保护只针对正在同步或尚未保存的操作。本机待同步记录本身不阻止应用重载。
- 原代码和笔记保持只读。对话回答仍需确认后另存为新批注，不覆盖已有批注或源文件。

## 源码交接时的验证

已通过 `npm run check` 与直接执行的 59 项相关测试（含 6 项使用现有 Rust 测试程序的批注回归）：

```powershell
node --import tsx --test tests/library-sync.test.ts tests/update-guards.test.ts tests/qiqi-provider.test.ts tests/sync-cancellation.test.ts tests/qiqi-chat.test.ts tests/document-client.test.ts tests/project-navigation.test.ts tests/reader-loading.test.ts tests/annotation-client.test.ts
```

新增浏览器用例已通过类型检查，尚未运行：

- `tests/browser/sync-independence.spec.ts`：失败项目保留旧正文、其他项目完成、仅重试失败项、取消与更新保护，覆盖 373/412/1440。
- `tests/browser/qiqi-provider.spec.ts`：三个模型逐一发送、参数与密钥隔离、返回自定义配置，覆盖 373/412/1440。

主代理需要重新构建，然后统一执行上述新用例及 `qiqi-chat.spec.ts`、`qiqi-update.spec.ts`、`local-first.spec.ts`、`reading-experience.spec.ts`、`app-updates.spec.ts`，再按需要完成全量回归。不能继续拿旧构建 `61cf1d25e9e1` 验证本轮修改。

上述为源码交接时的记录。后续统一构建、浏览器验收及修正见 [集成验收记录](integration-verification-2026-11-28.md)，网关实测与限制见 [七七说明](qiqi.md)。没有提交、推送或部署。
