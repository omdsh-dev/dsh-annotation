# Changelog

## [1.4.4] - 2026-08-28
### 兼容性
- **dsh 0.1.2-alpha.1**：安装自检改为使用新版 Web 一次性令牌入口并检查启动图登记，不再请求已移除的单插件裸地址。插件运行代码和宿主配置契约无需兼容层，也未修改 dsh 本体。官方 alpha 标签当前返回空启动图，真实页面激活仍被宿主缺陷阻塞，本版本不将其写成已通过。

## [1.4.3] - 2026-08-26
### 修复
- **未发送批注不再跨会话/页面切换丢失（issue #28）**：待发送批注原先只存于内存，切换会话或刷新页面后静默丢失。现按会话 ID 持久化到 localStorage（`dsh.annotation.pending.v1.<sessionId>`，Range 不可序列化故剥离、锚点元数据保留）；切换会话先写旧会话再读新会话，刷新后进入会话即恢复，恢复时按 seqKey/行首/上下文模糊搜索重新锚定并重绘脚注与高亮；发送成功或手动删除后才清空；损坏数据自动忽略并回退为空列表。回归测试见 `test/pending-storage.test.mjs`。

### 性能
- **流式期间不再逐 mutation 批次全文档扫描（issue #31）**：decorateAll 原先在 body 全树 MutationObserver（childList: subtree: characterData: attributes:）的每个相关批次上同步执行——流式输出期的主体批次是 attributes/characterData（实测 20s 内 245 批次、0 个 childList），每次都是 querySelectorAll('[data-chat-flow-kind]') + 每行子树查询 + textContent，成本随会话长度线性增长。现在只有含 childList（消息行插入）的批次才同步执行完整装饰（保证「隐藏批注块」先于绘制，无闪烁回归）；流式批次改为 500ms 限流的助手芯片增量扫描（行内 data-streaming 守卫不变，芯片替换时序不变）；1s 兜底轮询保留。实测 20s 流式窗口 CPU 采样中 querySelectorAll 命中从 ~100 降至 17，decorateAll 不再出现在热路径；长会话（500+ 行）预期每帧节省 1-4ms 主线程。

## [1.4.2] - 2026-08-24
### 文档
- 在中英文 README 中补充原生 `npm install @changfenhuang/dsh-annotation` 命令，并明确它只添加 Node 依赖；安装并激活 DSH 插件仍使用 `dsh plugin add`。
- 产品站安装命令同步改为 npm 公开包。

## [1.4.1] - 2026-08-18
### 发布
- npm 发布作用域改为个人账号 `@changfenhuang/dsh-annotation`；GitHub 仓库继续保留在 `omdsh-dev` 组织。同步更新运行时模块标识、资源路由和安装文档，不保留旧 npm 名称兼容层。

### 修复
- **斜杠命令不再被批注拼稿降级（issue #20）**：有待发送批注时输入 `/goal` 等命令并回车，v1.4.1 会把批注块前置进草稿，破坏 DSH 输入机的命令 token 前缀（watchClaim 释放声明），命令被降级为普通消息发出、goal 无法启用。现在命令草稿原样放行、不拼批注，批注保留并随下一条普通消息附带，同时弹 toast 提示（zh/en）。
- **恢复 Cmd/Ctrl+Enter 纯批注直接发送（issue #17）**：v1.3.18 为修 issue #10 把修饰键 Enter 全部排除，导致空草稿时 Cmd/Ctrl+Enter 无法直接发送纯批注。现仅在草稿为空时接管 Cmd/Ctrl+Enter，并在 capture 阶段主动 `submit('queue')`，避免 composer 的 accelerated 路径在「运行中 + 有排队消息」时误走 steerQueue 而把批注块留在输入框；草稿已有文字时仍交由 composer 处理，保留宿主的 Queue / Steer 策略。
### 兼容性
- **dsh 0.1.0-rc.8**：确认浏览器模块加载、会话作用域、输入提交、语言切换及批注依赖的页面锚点均保持兼容；无需增加兼容层，`npm run check` 全通过。
- **dsh 0.1.1-rc.2**：确认浏览器模块加载、会话作用域、输入提交、语言订阅及页面锚点契约仍保持兼容；无需增加兼容层，`npm run check` 3/3 通过，并在 rc.2 真实 Web 页面确认脚本加载与样式注入。

## [1.4.0] - 2026-08-18
### 新功能
- **语言跟随 DSH（issue #11）**：接入 `@deepseek-ai/dsh-client-locale` 的 `locale` 服务（`ctx.locale.getSnapshot().active` + `subscribe()`），UI 文案与批注协议块按 `zh`/`en` 双语生成与实时切换；气泡隐藏手术与反解析同时兼容 `提问：`/`Ask:`、`批注：`/`Note: ` 及「问题：」老格式，历史消息跨语言切换可解析；回复芯片保持语言中立的 `Annotation N`；locale 服务缺失时回退 zh，行为与旧版一致。

## [1.3.18] - 2026-08-18
### 修复
- **修饰键 + Enter 不再误触发拼稿（issue #10）**：`onKeyDown` 的 composer Enter 拦截只处理裸 Enter——Ctrl/Meta+Enter（官方 accelerated 提交）、Shift+Enter（换行）与浏览器默认换行路径都不会再调用 `attachAndSend`，批注块不再以明文出现进输入框；IME 守卫（isComposing / keyCode 229 / compositionend latch）保持不变。

## [1.3.17] - 2026-08-18
### 兼容性
- **dsh 0.1.0-rc.7 适配核查（无需代码改动）**：Node half 为零依赖空实现、`client.js` 自包含，不依赖任何 `@deepseek-ai/*` 运行时包；`dsh.client.inject` 依赖的 `@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-client-ui-conversation` 在 rc.7 契约不变；rc.7 conversation 新增 Safari textarea 修复不影响本插件依赖的 `data-composer-card` / `data-streaming` / `data-chat-flow` / `data-chat-anchor-key` / `data-time-hover-root` / `data-turn-tail` / `data-input-scroll` 等选择器；`npm run check` 通过，rc.7 全量 web 演练及线上健康检查通过。
