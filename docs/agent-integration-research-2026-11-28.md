# CodeSip 智能体接入调研

核对日期：2026-11-28。以下是官方仓库/文档的能力核对和结合本项目的工程判断，不代表已经完成模型接入或兼容性测试。本轮未把用户笔记、源码或凭据发送给模型服务。

## 建议

可实现“解释当前代码/选段 → 搜索相关文件 → 打开文件/定位 → 提出文档修改 → 查看差异 → 应用到我的编辑版”。CodeSip 已有 React 阅读界面、Rust 会话与项目权限、全文搜索、按 hash 读取文件、本机草稿、编辑副本及版本冲突检测，不必重写整个应用。

第一阶段建议做应用内助手：电脑右侧可收起/调整宽度的聊天面板，手机使用独立抽屉；默认不挤占正文。只发送用户选中的内容及完成任务所需的相关文件，显示上下文来源和工具执行状态。模型通过明确的应用工具调用操作 CodeSip，不依赖截图点击页面。

## 已有案例与适用边界

| 案例 | 官方资料中的能力 | CodeSip 可以借鉴什么 | 边界 |
| --- | --- | --- | --- |
| Copilot for Obsidian | 当前 README 描述 V4 代理工作流；支持选择 OpenCode、Claude、Codex，读取笔记、工具使用、文件变更、选区 Quick Ask、项目上下文、多个聊天；官方文档区分桌面 Copilot Chat 和移动 Quick Chat | 文档/选段作为上下文、工具进度、文件变更复核、切换到已有文件标签页 | 是 Obsidian 插件，不能当作通用 Web 组件直接塞进 CodeSip；代理能力依赖相应运行环境，不能把桌面 CLI 方案等同于手机方案 |
| Obsidian Smart Composer | 引用文件/目录上下文、建议并应用修改、库检索、自选模型与本地模型、MCP | “提问 → 建议修改 → 用户应用”的简洁体验 | README 明确说明不处于活跃开发；可借鉴交互，不建议把它当作持续维护的核心依赖 |
| CopilotKit | React 等前端集成、共享状态、前端工具、人工确认、流式 AG-UI 事件 | 让助手调用应用函数并展示确认卡片，复用聊天/工具 UI | 是开发框架，不是开箱即用的 CodeSip 文档代理；仍需实现权限、模型后端和编辑事务，接 Rust 后端还需对齐协议 |
| Zed + ACP | 编辑器通过 Agent Client Protocol 接入外部代理；协议有文件读写和权限请求 | 将来桌面端连接独立 Codex/Pi 等代理的桥接方向，代理与编辑器分离 | 浏览器/ArkWeb 不能直接启动本机 CLI；需要电脑桥接服务，电脑离线时不可用；每个代理/适配器版本要单独验证 |
| Vercel AI SDK | 官方 chatbot tool usage 文档展示服务端工具、客户端工具和用户确认流程 | 若新增 TypeScript 智能体服务，可复用流式对话与工具协议 | 当前生产 API 是 Rust；为用 SDK 引入 Node 服务会增加部署及会话代理工作，不能假定现有 Rust API 能直接 import 它 |

补充核对：Continue 的当前官方 README 明确写了仓库不再积极维护、对所有用户只读，并说明最终 2.0.0 发行。它可作代码阅读/编辑工作流参考，本轮不把它列为优先新依赖。

## 与当前代码的接入点

- `web/src/App.tsx`：当前账号、项目、路径、导航与项目搜索入口；增加助手开关与上下文选择。
- `web/src/ReaderWorkspace.tsx` / `CodeReader.tsx`：提供当前打开文件、选择范围、代码行；工具跳转复用现有导航，不重建阅读器。
- `web/src/MarkdownReader.tsx` / `DocumentEditor.tsx`：把建议转成可复核的 Markdown 修改。
- `web/src/documentStore.ts`：已有 `change`、`saveLocal`、副本同步和冲突处理；修改草稿要带来源 hash 与草稿版本，用户继续输入后旧建议不得覆盖新稿。
- `server-rust/src/http.rs`：现有会话认证、项目所有权、文件/manifest/search/document-copy 接口可复用。新增模型请求端点要沿用同一会话权限，服务端控制可读取的项目与路径。

首批工具建议：

| 工具 | 行为 | 执行约束 |
| --- | --- | --- |
| `list_files` / `search_project` | 列目录和搜索项目 | 当前账号可访问的项目，限制返回条数和单次内容量 |
| `read_file` | 读取指定文件或代码行段 | 绑定项目ID、路径和hash，不执行导入代码 |
| `open_file` / `reveal_lines` | 打开已有标签/定位选段 | 复用应用导航，保留其它标签与阅读位置 |
| `propose_document_edit` | 返回修改建议、说明、差异及基准版本 | 不直接改原文；校验结构与大小 |
| `apply_document_edit` | 应用用户选定的修改到“我的编辑版” | 用户能看到具体差异；版本一致才应用，保留撤销快照 |

正文中的“指令”只是内容；工具执行由应用校验参数和权限。停止生成要取消模型请求与未执行工具；工具失败、流中断和页面切换要明确反馈。跨账号缓存及对话必须隔离。模型密钥放服务器配置或系统凭据存储，不放前端构建产物。

## 实施顺序和工作量判断

1. **可用的解释助手，较小范围**：当前文件/选段问答、流式回复、停止、来源引用。先用一种支持工具调用的模型接口打通；不做全库向量化。
2. **可靠的应用助手，中等范围**：项目搜索与导航工具、修改预览、接受/拒绝、草稿版本校验、撤销、会话恢复、账号隔离及手机交互。这部分决定“能聊”是否升级为“能放心用”。
3. **桌面原文双向修改，较大范围**：Obsidian 原文回写、重命名/删除、跨设备冲突、电脑桥接、备份恢复。本项目目前的“我的编辑版”不会自动覆盖电脑原文，不能把这个说成已经支持。

工程估计而非工期承诺：稳定模型接口和测试账号就绪后，第一阶段通常是数天级原型；第二阶段应按一到两周的工程量评估；双向原文同步需另立范围。模型兼容、移动 WebView、离线/冲突测试都可能改变估算。当前没有为用户选择付费方案、配置新密钥或开启外部模型请求。

## 官方资料

检索接口本轮未返回可用网页结果，以上内容直接通过 HTTPS 核对官方仓库原文和官方文档；检索原文留在忽略的 `.local/reader-redesign-20261128/research/`，不纳入仓库。资料状态按核对日期记录，不保证后续不变。

- Copilot for Obsidian README：`https://github.com/logancyang/obsidian-copilot`
- Copilot Chat/代理与变更：`https://github.com/logancyang/obsidian-copilot/blob/master/docs/agent-mode-and-tools.md`
- Smart Composer（含维护声明）：`https://github.com/glowingjade/obsidian-smart-composer`
- CopilotKit 前端工具：`https://docs.copilotkit.ai/frontend-tools`
- CopilotKit 人工确认：`https://docs.copilotkit.ai/human-in-the-loop`
- AI SDK 客户端工具和确认：`https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage`
- Zed 外部代理：`https://zed.dev/docs/ai/external-agents`
- ACP 文件系统协议：`https://agentclientprotocol.com/protocol/v1/file-system`
- Continue 当前维护声明：`https://github.com/continuedev/continue`
