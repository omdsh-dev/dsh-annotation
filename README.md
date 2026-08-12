# dsh-annotation 2.0（纯插件内部版）

> **内部版本，禁止公开交付。** 本包 `private: true`，只允许私有仓库提交、私有 PR 与本地/内部安装。不得 `npm publish`、不得创建公共 Release。

DSH Web 批注插件 2.0（纯插件方案）：**DSH 0811 本体 0 文件、0 行改动**（适配基准 `4212975`）。全部代码只在本仓库。

## 架构

```
选中助手文字 → 批注（可留空）→ 原生 insertReference 芯片进入草稿
→ 用户输入问题 → 点击发送或 Enter（DSH 原生提交链，插件不拦截）
→ 引用编码器（0811 原始 ReferenceCodec 签名）把批注序列化为严格版本化信封
→ 消息文本携带信封进入模型请求
→ 插件 Node half 在 agent/pre-step 把信封拆成：
    ① 插件来源的原生折叠上下文（form: notice, summary "N 条批注"）
    ② 干净用户问题（保留原消息 ID）
→ 模型同一轮收到批注与问题；历史/气泡/标题只呈现干净问题与原生折叠行
```

- 浏览器端只做采集与插入原生引用：不监听 Enter、不拼稿、不碰输入框 DOM、不接管输入法。
- 传输信封：`<dsh-annotation-v1>{"version":1,"id":"<uuid>","quote":"…","note":"…"}</dsh-annotation-v1>`，JSON 内 `<` 转义防止伪造结束标签；解析严格（未知版本/字段/超限 → 整条原样放行），解析器永不 throw。
- 生命周期（按会话持久化）：编辑中 → 已附加 → 已提交（chip 消失，乐观）→ 已排队 / 已落盘（历史出现原生上下文行，自动清理）/ 失败（发送失败回灌，chip 回归）/ 状态未知（队列被编辑，禁止自动重发）。
- 刷新恢复：仅当草稿指纹完全匹配时自动重建芯片；否则面板保留、由用户点击「重新附加」。

## 明确不承诺（DSH 0 改动下的边界）

| 能力 | 结论 |
|---|---|
| 队列编辑后原子保留批注 | 不保证（队列预览可能短暂显示信封） |
| Host 回包丢失自动判定 | 不保证 |
| 自动重试且绝不重复 | 不保证（禁止自动重试） |
| 永久稳定助手消息 ID 锚点 | 0811 未公开；锚点用基线 `data-chat-anchor-key` + 文本偏移 |
| 一次性子智能体发送 | DSH 原生不支持 |
| 助手回复悬浮 `Annotation N` 芯片 | 删除，不做 DOM 猜测 |

## 构建与检查

```bash
pnpm install                    # 第三方依赖
node scripts/link-dsh.mjs       # 链接本机 0811 快照的 @deepseek-ai 类型包（只读，指向未修改 staging）
npm run build                   # tsdown：client.js（浏览器 bundle）+ lib/index.mjs（Node half）
npm test                        # vitest（信封/解析器/Node 拆解/状态机/锚点/面板）
npm run check                   # tsc --noEmit + node --check
npm pack --dry-run              # 私有包内容检查
```

## 目录

- `src/client/` — 浏览器端（注册表/锚点/编码器/面板/高亮）
- `src/node/` — Node half（`agent/pre-step` 拆解监听器）
- `src/shared/` — 信封编解码（两端复用）
- `tests/` — vitest
- `cordis.patch.yml` — bundle patch（仅一次 insert 自身 id）
