# 七七菜单与 Pi 接入（2026-11-28）

手机首页底部菜单调整为“学习笔记 / 代码项目 / 七七”，阅读主题入口位于顶部；电脑侧栏在两个资料入口之后放置七七。阅读页隐藏全局菜单时，仍能从阅读工具栏打开同一七七实例和主题选择。切换页面保留聊天输入；主题选择复用 Modal 的键盘焦点管理。按钮 accessible name 继续为“打开七七”和“切换明暗主题”，第三项菜单可见文字为“七七”。

## 核对来源与选择

用户所指的 `badlogic/pi-mono` 在核对时重定向到 `earendil-works/pi`。GitHub 官方仓库元数据、`packages/agent/README.md`、`packages/agent/src/agent.ts`、`packages/ai/src/types.ts` 和 npm 包元数据均已核对；这次安装固定为 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-schema` 1.7.0。官方仓库提供 MIT 许可，Web 发布包附带原文。核对原始资料保存在忽略目录 `.local/qiqi-pi-20261128/research/`。

官方来源：

- https://github.com/badlogic/pi-mono （重定向）
- https://github.com/earendil-works/pi/tree/main/packages/agent
- https://github.com/earendil-works/pi/tree/main/packages/ai
- https://github.com/earendil-works/pi/blob/main/LICENSE

本次采用可嵌入的 Agent 核心，通过其 `streamFn` 接入既有网关传输；没有将 Pi coding CLI 或完整 Web UI 放入应用，也没有引入独立代理服务器。现有聊天 UI、密钥设置、流错误处理和 Rust 部署保持各自职责。构建中 Pi 模块约 85 KB / gzip 26 KB，通过动态 import 加载，普通阅读入口不加载它。

## 实现边界

- `qiqiChat.ts`：数据类型、账户隔离、配置校验、引用和延迟加载入口。
- `qiqiAgent.ts`：真正调用 Pi Agent，管理多轮模型请求、工具执行、终止、严格参数检查和调用预算。
- `qiqiTransport.ts`：兼容 API 的 SSE/JSON 传输，只使用明确配置的 Key；支持完整校验后的工具调用，不执行未完成响应中的调用。
- `qiqiReferences.ts`：只读取本次用户授权的单个源文件；绑定账号/项目/路径/版本，按行限量返回。
- `QiqiPanel.tsx` / `useQiqiChat.ts`：输入引用、单次读取授权、可见工具状态、历史和停止/退出清理。
- `ReadingThemeMenu.tsx`：独立主题选择；`App.tsx` 仅放置入口和共享聊天实例。

Pi 的 schema 默认允许部分类型强制转换。实际单测发现小数行号会被转成整数，故通过 `prepareArguments` 加严格验证，避免自动读到不同位置。当前工具没有读取其他文件、写入、执行、搜索或网络抓取能力。原文未改变；修改建议由用户通过现有“另存为批注”功能保存。授权只有当前发送有效，历史会显示曾授权，但后续新消息不会继承。

## 验证范围

`tests/qiqi-agent.test.ts` 覆盖真实 Pi 工具循环、授权不继承、伪造工具/路径、小数和越界行号、SSE 分片、中断不执行、停止工具、调用预算、行号和大小边界。既有 `qiqi-chat.test.ts` 现在也经过 Pi 运行时，保持原有网关隐私、流错误和停止语义。

`tests/browser/qiqi-navigation-agent.spec.ts` 在 373/412/1440 宽度下覆盖新菜单、顶部主题、跨页面输入、默认只发送选段、单次授权读取、工具结果进入下一次模型请求、源版本过期拦截和原文保持不变。使用隔离测试服务、合成项目和合成模型响应；未读取私人笔记，未使用真实模型 Key。

已有主题回归仅调整入口定位，保留配色、持久化和阅读位置断言。同步/归档逻辑未修改，其既有回归作为菜单迁移的兼容性验证。完整结果记录在忽略目录 `.local/qiqi-pi-20261128/`，线上版本需以发布校验记录为准。

验收结果：类型检查、120 项单测、Web/Rust 构建通过；57 项相关浏览器回归通过，15 项按设备家族跳过。最终构建 Web `5500b793cbec` 再跑新增工具/导航及应用更新保护，7 项通过、3 项按设备家族跳过。373/412/1440 截图均已检查，未完成 HarmonyOS 真机验收。
