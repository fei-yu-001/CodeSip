# 七七阅读助手

顶部「七七」打开聊天面板；代码、笔记中的「七七」按钮引用选中片段（未选择时引用当前行或当前段）。在批注抽屉点击「问七七」，还会带入正在编辑的批注文字。引用先显示在输入区，点击发送后才请求 API。

在面板的「API 设置」首次打开时预填 `https://ai.ximupowers.tech/v1`，模型用下拉菜单选择：

- DeepSeek V4.1 Flash：`deepseek-ai/DeepSeek-V4.1-Flash-1017`
- GLM 5.3：`GLM-5.3`
- GLM 5.3 Flash：`zai-org/GLM-5.3-Flash`

密钥仍由用户在设置中填写，仓库只保存公开地址和模型 ID。已有自定义接口保持原配置；API 地址改为其他服务后，模型恢复为可输入的字段。「使用七七预设」或手动把 API 地址改到不同来源（协议、主机或端口）时，会清空原密钥与记住选项；同一服务内调整端点会保留密钥。

也可以填写其他兼容 OpenAI Chat Completions 的 API 地址、模型名称和密钥。地址支持服务商的基础路径（如 `https://provider.example/v1`）或完整的 `/chat/completions` 端点。无需密钥的本机服务可留空密钥。本机地址允许 HTTP，其他地址要求 HTTPS。

当前实现由浏览器直接连接提供的地址，因此服务需支持 CORS，并允许 `Content-Type`、`Authorization` 请求头。它没有服务器代理，也不支持仅提供 Anthropic Messages 或 Responses 协议的地址。保存配置不会发起模型请求或消耗生成额度。

密钥默认只在当前页面内存中保留；明确勾选「在此设备记住密钥」后，存入当前账号的浏览器本地存储。设置与对话不随笔记同步，退出账号时由现有清理流程清除。密钥只进入服务商请求的 Authorization 头，不进入消息、批注或错误提示。

聊天支持流式回答、停止、失败重试、20 段本机历史、Markdown 显示与复制。发送范围限于这段对话及手动添加的片段；不会搜索整个项目或自动读取其他笔记。长引用会提示截取，超长对话会要求新建对话。

有引用的回答可以「另存为批注」。用户可编辑批注草稿，点击「确认保存批注」才进入既有批注保存与同步流程。先保存在本机，点击项目的「同步」才上传。每次生成新的批注 ID，原批注和源文件保持不变，避免历史建议覆盖后来的修改。保存的引用遵循现有 2000 字上限，批注正文为 10000 字上限。对话保留所引片段及来源版本，不代表实时读取了该文件的新版本。

## 模块边界

`QiqiPanel.tsx` 管面板导航、输入和引用草稿；`QiqiSettings.tsx` 管设置表单与尚未保存的配置；`useQiqiChat.ts` 管对话历史、生成生命周期和账号清理；`qiqiChat.ts` 管数据校验及流式协议；`qiqiProviders.ts` 只保存公开服务元数据。它们不依赖项目同步调度器或应用更新实现，更新保护通过通用的 `useUpdateGuard` 注册具体原因。

## 验证

- `npm run check`
- `node --import tsx --test tests/qiqi-chat.test.ts`
- 重新构建后运行 `npm run test:e2e -- tests/browser/qiqi-chat.spec.ts`。浏览器用例仅使用合成项目和拦截的 API 响应，不调用真实模型、不访问私人笔记。覆盖桌面 1440、手机 373/412，代码选区、笔记批注、API 配置、连续对话、另存批注、刷新、重试、停止、退出清理及原文不变。

- 预设模型单测：`node --import tsx --test tests/qiqi-provider.test.ts`。
- 新增 `tests/browser/qiqi-provider.spec.ts`，合成响应覆盖三个模型逐一发送、自定义接口往返、不同服务密钥不复用、373/412/1440 宽度与退出设置后释放更新保护。
- `tests/browser/qiqi-update.spec.ts` 保留关闭按钮、Escape、后退及真正更新重载的集成检查。
- 2026-11-28 统一验收：公开网关 OPTIONS 返回 204，允许请求头为 `*`，未单独列出 `Authorization`。实际 Chromium 159.0.8154.6 使用合成无效 Key、`credentials: omit` 发起跨域请求后读到 HTTP 401；应用显示“API 拒绝访问，请检查密钥和模型权限”，可重试或返回设置。此环境中没有发生 CORS 阻断，不能只根据 OPTIONS 报头认定直连不可用。
- 同一浏览器的独立本机对照：明确允许 Authorization 时可读取响应，缺少该许可且没有通配符时请求失败，通配符时可读取响应；未使用关闭 Web 安全的参数。没有用真实密钥生成回答，也没有验证 HarmonyOS/其他 WebView，跨域兼容性仍需在目标真机确认。
- 网关探测禁用 trace，未读取凭据文件；仅保存白名单响应元数据和合成内容截图，位于忽略的 `.local/decoupling-acceptance-20261128/`。

完整结果与验收修正见 [集成验收记录](integration-verification-2026-11-28.md)。
