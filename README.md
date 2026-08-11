# dsh-annotation 2.0（内部开发版）

> **内部版本，禁止公开交付。** 本包 `private: true`，只允许私有仓库提交、私有 PR 与本地/内部安装。不得 `npm publish`、不得创建公共 Release，不得在公开文档中暴露内部接口。

DSH Web 批注插件 2.0：选中已完成生成的助手回复添加批注（可留空），经 **DSH 原生原子提交通道**随问题一次 RPC 发送；Host 严格校验并以固定格式上下文旁路数据携带；Core 在 `agent/pre-step` 前确定性展开为原生 `ContextMessage(form: notice)` —— 历史呈现、搜索、复制、标题、队列全部使用 DSH 原生消息体系，插件关闭后已发送的批注历史照常显示。

## 与 v1.x 的本质区别

| 维度 | v1.x（已废弃） | 2.0 |
|---|---|---|
| 传输 | 自然中文拼稿进草稿（气泡隐藏、正则改写） | 结构化 `PromptContextBatchV1` 旁路数据，不碰用户问题文本 |
| 发送 | 拦截 Enter 拼稿 | 点击发送与 Enter 同一条原生提交链（原子提交，Host 接受后才清空） |
| 历史 | MutationObserver 隐藏/芯片替换 | 原生 ContextMessage 折叠提示行 |
| 数据 | 仅内存 | 每会话 localStorage 持久化，刷新/切会话/重开恢复 |
| 依赖 | 全页面 DOM 修补 | 仅 composer.dock 槽位 + CSS Custom Highlight + rAF 合并重定位（无 body 观察器、无轮询） |

## 构建与检查

```bash
pnpm install          # 装第三方依赖
node scripts/link-dsh.mjs   # 链接本机 DSH 快照的 @deepseek-ai/* 类型包（$DSH_SOURCE 可覆盖）
npm run build         # tsdown → client.js（ModuleLoader 闭包工厂产物）
npm test              # vitest（状态机/锚点/持久化/批次/面板）
npm run check         # tsc --noEmit + node --check
npm pack --dry-run    # 私有包内容检查
```

`client.js` 为生成产物并提交（bundle 安装方式按 `package.json` exports 读取）。构建依赖本机 DSH 快照（`scripts/link-dsh.mjs` 中默认路径或 `$DSH_SOURCE`）。

## 数据流

```
助手稳定消息（data-dsh-assistant-*）选区
→ 插件保存结构化批注（AnnotationDraftStateV1，每会话 localStorage）
→ 面板「批注 ×N」；chip 插入草稿（clipboard 投影为空）
→ 原生提交链冻结快照 → 一次 RPC（session.prompt + context 批次）
→ Host 严格校验 + SHA-256 幂等（同批次重试返回首次 messageId）
→ Core 展开为 ContextMessage(notice, "N 条批注") + 干净 UserMessage
→ 模型与历史同时使用原生消息体系
```

限制：每会话最多 32 条批注；单条引用 8 KiB；单条说明 4 KiB。批注身份由 ID + 消息锚点决定（相同文字可分别批注）；锚点恢复限定同一消息（原文 → 前后文消歧 → 「原文位置已变化」），脱离后仍可发送。

## 目录

- `src/client/` — 浏览器端（registry、锚点、codec、面板、高亮）
- `tests/` — vitest（jsdom 组件测试 + 纯逻辑测试）
- `index.mjs` — Node half 空实现
- `cordis.patch.yml` — bundle patch（仅一次 insert 自身 id）
