# Changelog

## [1.3.18] - 2026-08-18
### 修复
- **修饰键 + Enter 不再误触发拼稿（issue #10）**：`onKeyDown` 的 composer Enter 拦截只处理裸 Enter——Ctrl/Meta+Enter（官方 accelerated 提交）、Shift+Enter（换行）与浏览器默认换行路径都不会再调用 `attachAndSend`，批注块不再以明文出现进输入框；IME 守卫（isComposing / keyCode 229 / compositionend latch）保持不变。

## [1.3.17] - 2026-08-18
### 兼容性
- **dsh 0.1.0-rc.7 适配核查（无需代码改动）**：Node half 为零依赖空实现、`client.js` 自包含，不依赖任何 `@deepseek-ai/*` 运行时包；`dsh.client.inject` 依赖的 `@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-client-ui-conversation` 在 rc.7 契约不变；rc.7 conversation 新增 Safari textarea 修复不影响本插件依赖的 `data-composer-card` / `data-streaming` / `data-chat-flow` / `data-chat-anchor-key` / `data-time-hover-root` / `data-turn-tail` / `data-input-scroll` 等选择器；`npm run check` 通过，rc.7 全量 web 演练及线上健康检查通过。
