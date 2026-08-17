# dsh-annotation

<div align="center">

[English](./README.md) · **简体中文**

</div>

<p align="center">DSH Web 选中批注插件：选文字 → 批注 → 回车随消息发给模型，回复按批注编号逐条对照</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/blue" alt="license">
</p>
<img width="2940" height="1770" alt="image" src="https://github.com/user-attachments/assets/c3186efc-44d3-4e7f-9523-1902d9d037e9" />
<img width="2940" height="1770" alt="image" src="https://github.com/user-attachments/assets/0b48ac02-4648-4b94-8d8f-344f8b7c25b4" />
<img width="2940" height="1770" alt="image" src="https://github.com/user-attachments/assets/8b2610d0-3d00-41be-b314-bac2fe616787" />
<img width="2940" height="1770" alt="image" src="https://github.com/user-attachments/assets/9b66deea-3786-4296-9b0d-52873a15f5e1" />

选中助手回复里的任意文字即可批注（批注内容可留空 = 仅标记原文），跨消息、跨回合连续收集；底部输入框旁出现「批注 ×N」标签（悬浮可见全部内容、可删单条）；直接回车，批注块随输入框里的问题一起发给模型。**你的消息气泡里不会出现批注块文本**——只显示问题和「批注 ×N」标签（hover 看内容，绘制前隐藏、零闪烁）；模型回复按「Annotation 1：…」逐条回应，回复里的每个 Annotation 标签都可悬浮查看对应批注的原文与内容。

形态：官方 **bundle 插件**（`dsh.bundle` + package.json `dsh.client` 声明，经 client-modules 注入浏览器端，Node half 为空实现）。**零核心改动**——不改 DSH 本体任何文件，`cordis.patch.yml` 仅一次 `insert` 自身 id，profile patch 保持 `[]`。

## 能力

| 功能 | 说明 |
|---|---|
| 选中即批注 | 选中助手文字 → 工具条「批注」→ 直接写批注（可留空），点选外处或 Esc 收起 |
| 编号脚标 + 高亮 | 原文位置亮蓝编号 + 高亮，视口内锚定、碰撞避让，滚出屏幕不丢失 |
| 跨回合收集 | 任意多条批注跨消息/回合累积，编号从 1 开始 |
| 「批注 ×N」标签 | 输入框旁小标签，悬浮显示全部批注内容，可逐条删除 |
| 回车随消息发送 | 批注块 + 输入框问题一起发给模型（模型收到完整内容） |
| 气泡隐藏批注块 | 发送瞬间（浏览器绘制前）批注块从气泡 DOM 隐藏，只留问题 + 「批注 ×N」标签，hover 可见内容；刷新后历史消息自动修复 |
| 回复逐条对照 | 消息内注入格式指令，模型按「Annotation 1：…」…「Annotation N：…」逐条回应 |
| 回复批注芯片 | 回复里的「Annotation N：」渲染为可悬浮芯片，hover 显示该批注的原文 + 批注内容 |

## 交互流

```
选中助手文字 ──▶ 工具条「批注」──▶ 写批注/留空保存 ──▶ 原文亮蓝编号+高亮
        ▲                                                    │
        └────────────── 任意多条、跨回合累积 ◀────────────────┘
                        │
                        ▼
              输入框旁「批注 ×N」标签（hover 看内容/删除）
                        │
                    回车发送
                        ▼
   模型收到：批注块（编号+原文+批注）+ 你的问题
   你的气泡：只显示问题 +「批注 ×N」标签（零闪烁）
   模型回复：Annotation 1：… Annotation 2：…（可悬浮芯片）
```

## 安装（官方 bundle 路径 · 唯一）

```sh
# GitHub 公开仓库安装（无需 npm 账号）
dsh plugin --profile web add git+https://github.com/omdsh-dev/dsh-annotation.git
# 本地路径安装（开发调试）
cd /path/to/dsh-annotation
dsh plugin --profile web add .
# 重启 web —— 见下方「重启 web 服务」
```

| 做 | 不做 |
|----|------|
| 只 `dsh plugin add` / 只写 `bundles` | **不要**再在 profile/home `cordis.patch.yml` insert 同 id |

自检：

```sh
dsh --profile web --dump-config | rg "id: dsh-annotation"   # 必须恰好 1 行
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3080/plugins/@omdsh-dev/dsh-annotation/client.js"   # 200
```

## 重启 web 服务

按平台选择对应命令：

```sh
# macOS（launchd）
launchctl kickstart -k "gui/$(id -u)/com.dsh.web"

# WSL / Linux（systemd 用户服务）
# 服务名可能因安装方式而异，可用以下命令确认：
#   systemctl --user list-units | rg dsh
systemctl --user restart dsh-web
```

没有服务管理器的环境（如部分容器）通常**不需要重启**：`client.js` 按请求读取、no-cache，硬刷新（Cmd/Ctrl+Shift+R）即可加载插件改动。上面的自检命令跨平台通用。

## 架构要点

- **纯浏览器端**：全部能力在 `client.js`（hand-written CJS bundle，无构建步骤，按请求读取 no-cache）
- **消息格式**（跟随 DSH `locale` 语言偏好，zh/en 双语）：

  ```
  zh：我批注了以下 N 处内容…\n\n1. 原文\n   批注：…\n\n请用「Annotation 1：…」…\n\n提问：
  en：I annotated the following N passage(s)…\n\n1. quote\n   Note: …\n\nPlease respond… "Annotation 1: …"…\n\nAsk:
  ```

  （zh 分隔标记用「提问：」而非「问题：」——标题行「回答我的问题：」里也含它，气泡隐藏手术会误命中；en 用 `Ask:`。隐藏手术与反解析同时兼容两种语言及「问题：」老格式）
- **气泡隐藏**：用户气泡是纯文本渲染（MessageText 单节点，非 markdown）；MutationObserver 微任务阶段（绘制前）按最后一个 `\n提问：` 切掉批注块、贴「批注 ×N」标签；1s 轮询兜底 + 刷新后历史消息自动修复
- **回复芯片**：回复流式结束后（`data-streaming` 移除），把「Annotation N：」替换为可悬浮芯片；条目数据存于最近一条带批注标签的用户消息上（`tag.__annotationItems`），刷新后自动重建；**改 DOM 前先快照 TreeWalker 收集的文本节点再逐个替换**（遍历中途 replaceChild 会让 walker 指针失效，只处理到第一个节点）
- **语言跟随**：UI 文案与批注协议块跟随 DSH `locale` 服务（zh/en，实时切换）；历史气泡跨语言可解析；locale 服务缺失时回退 zh
- **IME 安全**：Enter 拦截带 `isComposing`/keyCode 229 守卫；不 DOM 硬改 composer textarea；`setDraft` 仅在提交前一刻拼批注块，不覆盖用户草稿
- **不依赖发送完成事件链**：气泡装饰走 MutationObserver + 轮询（`watchInputDraft` 在初始化时会话未加载时会失效，仅作暂存入口）
- **聚焦对话兼容**：支持 [dsh-focus-chat](https://github.com/dingyi222666/dsh-focus-chat) 的聚焦会话视图——其助手行是 `[data-focus-flow]` 内 class 含 `*_assistant`（CSS Modules 哈希名）的容器（流式期间行带 `data-streaming`）；选区批注、回复芯片、角标重新定位在聚焦 tab 与主视图一样可用

## 版本历史

| 版本 | 内容 |
|---|---|
| v1.4.x | 语言跟随：zh/en UI 文案与批注协议块，经 DSH `locale` 服务实时切换 |
| v1.3.x | 回复逐条对照：格式指令注入 + 「Annotation N：」可悬浮芯片（TreeWalker 快照修复） |
| v1.2.x | 气泡隐藏批注块：MutationObserver 微任务零闪烁 + 轮询兜底 + 历史消息修复 |
| v1.x | 自包含批注流（取代 v0.9 chip 设计）：capture Enter 拼稿随消息发送 |
| v0.9.x | 早期 chip 设计（insertReference + slash codec），已被 v1.x 取代 |

## 友情链接

- [Linux.do](https://linux.do)

## License

MIT
