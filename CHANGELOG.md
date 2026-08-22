# Changelog

## [Unreleased]
### 修复
- **斜杠命令不再被批注拼稿降级（issue #20）**：有待发送批注时输入 `/goal` 等命令并回车，v1.4.1 会把批注块前置进草稿，破坏 DSH 输入机的命令 token 前缀（watchClaim 释放声明），命令被降级为普通消息发出、goal 无法启用。现在命令草稿原样放行、不拼批注，批注保留并随下一条普通消息附带，同时弹 toast 提示（zh/en）。
### 兼容性
- **dsh 0.1.0-rc.8**：确认浏览器模块加载、会话作用域、输入提交、语言切换及批注依赖的页面锚点均保持兼容；无需增加兼容层，`npm run check` 全通过。
- **dsh 0.1.1-rc.2**：确认浏览器模块加载、会话作用域、输入提交、语言订阅及页面锚点契约仍保持兼容；无需增加兼容层，`npm run check` 3/3 通过，并在 rc.2 真实 Web 页面确认脚本加载与样式注入。

## [1.4.1] - 2026-08-18
### 修复
- **恢复 Cmd/Ctrl+Enter 纯批注直接发送（issue #17）**：v1.3.18 为修 issue #10 把修饰键 Enter 全部排除，导致空草稿时 Cmd/Ctrl+Enter 无法直接发送纯批注。现仅在草稿为空时接管 Cmd/Ctrl+Enter，并在 capture 阶段主动 `submit('queue')`，避免 composer 的 accelerated 路径在「运行中 + 有排队消息」时误走 steerQueue 而把批注块留在输入框；草稿已有文字时仍交由 composer 处理，保留宿主的 Queue / Steer 策略。

## [1.4.0] - 2026-08-18
### 新功能
- **语言跟随 DSH（issue #11）**：接入 `@deepseek-ai/dsh-client-locale` 的 `locale` 服务（`ctx.locale.getSnapshot().active` + `subscribe()`），UI 文案与批注协议块按 `zh`/`en` 双语生成与实时切换；气泡隐藏手术与反解析同时兼容 `提问：`/`Ask:`、`批注：`/`Note: ` 及「问题：」老格式，历史消息跨语言切换可解析；回复芯片保持语言中立的 `Annotation N`；locale 服务缺失时回退 zh，行为与旧版一致。

## [1.3.18] - 2026-08-18
### 修复
- **修饰键 + Enter 不再误触发拼稿（issue #10）**：`onKeyDown` 的 composer Enter 拦截只处理裸 Enter——Ctrl/Meta+Enter（官方 accelerated 提交）、Shift+Enter（换行）与浏览器默认换行路径都不会再调用 `attachAndSend`，批注块不再以明文出现进输入框；IME 守卫（isComposing / keyCode 229 / compositionend latch）保持不变。

## [1.3.17] - 2026-08-18
### 兼容性
- **dsh 0.1.0-rc.7 适配核查（无需代码改动）**：Node half 为零依赖空实现、`client.js` 自包含，不依赖任何 `@deepseek-ai/*` 运行时包；`dsh.client.inject` 依赖的 `@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-client-ui-conversation` 在 rc.7 契约不变；rc.7 conversation 新增 Safari textarea 修复不影响本插件依赖的 `data-composer-card` / `data-streaming` / `data-chat-flow` / `data-chat-anchor-key` / `data-time-hover-root` / `data-turn-tail` / `data-input-scroll` 等选择器；`npm run check` 通过，rc.7 全量 web 演练及线上健康检查通过。
