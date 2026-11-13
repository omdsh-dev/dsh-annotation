# 批注标记层滚动性能审计（只读）

- **审计对象**：`client.js` HEAD 基线 `48eac63`（主分支），git blob `c8e0c23`，2870 行 / 145,145 字节。
- **审计时工作树状态**（2026-11-10 20:2x）：`git status` 显示 `M client.js`、`M test/layout-overlay.test.mjs`、`M test/pending-chip-position.test.mjs`，并新增未跟踪的 `test/marker-scroll.test.mjs`——Lead 正在并行实施性能修复并已同步适配两个单测。**本报告的热点与行号均以 HEAD 基线为准**；§9 单独记录工作树现状与风险。
- **宿主**：DSH `0.2.2-rc.1`（`@deepseek-ai/dsh`）。滚动容器源码在 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`，聊天视口在 `@deepseek-ai/dsh-client-ui-chat/lib/client.js`。
- **基线测量**：审计时 `test/perf-baseline.json` 尚未生成（`perf-bench` 未交付）。本文量级估算见 §6，基线数字出现后回填 §10。
- **约束**：只读审计，未修改任何源码或测试；字段/标识符/行号保持原文。

---

## 0. TL;DR

用户反馈的两个症状（「批注一多滚动卡顿」「高亮块与编号图标慢半拍」）是同一组结构性成本的两个侧面：

1. **滚动帧 = 全量重建帧**。`markersSignature()`（`client.js:1585`）把每条批注的 rect 四舍五入后拼进签名（`:1595`），滚动 1px 签名就变；`renderMarkers()`（`:1698`）随即 `overlay.textContent = ''` + `numLayer.textContent = ''`（`:1709-1710`）并调用 `buildMarkers()`（`:1715`）**从头创建全部高亮块与编号**。滚动时每帧都是「清空 + 重建」。
2. **3N 次全文档查询**。`buildMarkers()` 在**每条批注的循环体内**重复调用 `hostLocalRects('scrollBody')`（`:1759`）、`hostHeaderRects()`（`:1766`）与 `hostComposerRects()`（`:1766`）。每个函数内部都是 `document.querySelectorAll('[class*="_<local>"]')`（`:1613`）——属性子串选择器无法走 class 索引，必须扫全文档。N=20 时每帧 ≈ 60+ 次全文档查询，外加 `conversationColumnRange()` 的 N 次 `querySelector('[data-conversation-scroll]')`。
3. **重复定位**。签名阶段对每条批注 `locateQuote` + `quoteRects`（`:1589-1591`），`buildMarkers` 里再各来一次（`:1720-1722`）——滚动帧每帧 2N 次定位、2N 次 `range.getClientRects()`。
4. **fixed 标记层的坐标必须由主线程逐帧写**。正文滚动在合成线程（原生 `overflow-y:auto`），而标记层是 `position:fixed`、子元素也 `position:fixed`（`:1057`、`.dsh-ann-hl` `:147`），不会随滚动自动移动。主线程被上面 1-3 项打满时，标记只能滞后到后续帧才追上——这就是「慢半拍」。
5. **旁路持续烧主线程**。流式输出的每帧 mutation 批次都会经 `MutationObserver`（`:1326-1349`，无 `attributeFilter`）触发 `onLayoutChange` → 同样的全量重建；此外 `decorateAll` 1s 轮询（`:2747`）与 120ms 合并（`:2731`）在长会话上做全行 `textContent` 扫描；`updateChip()`（`:2118`）每帧重建胶囊子节点并读 `offsetWidth/offsetHeight`（`:2152-2153`）强制同步布局。

修复方向与 Lead 正在实施的方案一致（宿主几何元素缓存、Range 缓存、元素池、clipPath 去抖、updateChip 拆分、观察器降噪）；§8 给出逐项风险与**必须保留的既有测试断言**，§9 列出并行实现中已出现/仍可能遗漏的风险。

---

## 1. 滚动调用链与每帧成本

### 1.1 事件链

```
scrollBody 原生滚动（合成线程）
  └─ window scroll capture  → onLayoutChange()          client.js:1308
       └─ rAF 合并（anchorRaf 布尔）                      :1267-1307
            ├─ if (ui.quotes.length > 0) renderMarkers()  :1272
            │    ├─ hostComposerRects().concat(hostHeaderRects())  :1700
            │    ├─ overlay.style.clipPath / numLayer.style.clipPath :1701,:1704
            │    ├─ markersSignature(holes)                :1705
            │    │    └─ for each quote: locateQuote + quoteRects   :1587-1597
            │    └─ if (sig !== markersSig) { textContent=''; buildMarkers() } :1707-1712
            │         └─ for each quote: locateQuote + quoteRects + 3N 次宿主查询 + 全量 DOM 创建
            ├─ updateChip()                                :1273 → :2118
            ├─ if editing: positionEditor(...)             :1274 → :1558
            └─ if actions: locateQuote / live range 定位    :1275-1305
```

`requestAnimationFrame` 合并保证一个帧内最多执行一次 `onLayoutChange` 的 rAF 回调；但**合并的是事件，不是成本**——只要还有批注，滚动期间每帧都会完整走一遍 `renderMarkers()`。

### 1.2 逐函数成本表（滚动帧）

记号：`N` = 批注条数；`R` = 会话 DOM 消息行数（`[data-chat-flow-kind]` 元素数）；`M` = 单条批注跨的 DOM 行数（`getClientRects()` 长度）；`D` = 文件批注文本节点到滚动容器的祖先层数；`E` = 全文档元素数。

| 步骤 | 位置（HEAD） | 每帧调用次数 | 复杂度 | 说明 |
|---|---|---|---|---|
| `scroll` capture | `:1308` | 每次滚动事件（合并后 1 组） | O(1) | 不冒泡但 capture 可达；不读布局 |
| `onLayoutChange` rAF | `:1267-1307` | ≤1 | O(1) | 仅置位/清理 |
| `renderMarkers` | `:1698` | 1 | — | 入口 |
| `hostComposerRects` | `:1677` | 1 | `querySelectorAll('[class*="_composerSeat"]')` 全文档 O(E) | 无 seat 时回退 `querySelector('[data-composer-card]')`（`:1680`） |
| `hostHeaderRects` | `:1656` | 1 | `conversationColumnRange()`（`querySelector`，`:1631`）+ `hostLocalRects('header')` 全文档 O(E) | 再逐矩形与会话列求交 |
| `clipWithHoles` | `:1687` | 1（无洞时 0） | O(holes) | 纯字符串 |
| `overlay.style.clipPath =` | `:1701` | 1 | fixed 层裁剪失效/重绘 | 无条件写 |
| `numLayer.style.clipPath =` | `:1704` | 1 | 同上 | 每帧读 `overlay.style.clipPath` 再写 |
| `markersSignature` | `:1585` | 1 | N × (`locateQuote` + `quoteRects`) + 字符串拼接 O(ΣM) | 见 §1.3 |
| `locateQuote` | `:702` | N（签名）+ N（build）= **2N** | 快路径 O(L_quote)；慢路径 O(R × L_row) 全文扫描 | 见 §1.6 |
| `quoteRects` | `:456` | **2N** | O(M) + 文件批注 O(D) 次 `getComputedStyle` + `getBoundingClientRect` | 见 §1.5 |
| `overlay.textContent=''` / `numLayer.textContent=''` | `:1709-1710` | 1（滚动帧必触发） | 删除 ΣM + N 个节点 | 见 §1.3 |
| `buildMarkers` | `:1715` | 1（滚动帧必触发） | N × 定位 + **3N 次全文档查询** + 12N² 碰撞检查 + ΣM+N 节点创建 | 见 §1.4 |
| `updateChip` | `:2118` | 1 | 1 次 `querySelector` + 2 次强制同步布局 + 子节点重建 | 见 §2 |
| `positionEditor`（仅 editing） | `:1558` | 1 | 2 次强制同步布局（`offsetWidth/Height`） | 滚动时编辑卡每帧重算 |
| `MutationObserver` 回调（流式） | `:1326` | 每帧 1 批（注释实测 20s/245 批 ≈ 12/s） | O(mutations × 祖先深度 × 选择器数) | 见 §3 |

### 1.3 为什么「滚动 = 全量清空重建」

`markersSignature()` 的签名由三部分组成：

```js
// client.js:1587-1604（HEAD）
for (var i = 0; i < ui.quotes.length; i++) {
  var q = ui.quotes[i]
  var range = locateQuote(q.text, q)                     // :1589
  if (range === null) { parts.push(q.id + ':gone'); continue }
  var rects = quoteRects(range, q)                       // :1591
  for (var c = 0; c < rects.length; c++) {
    var r = rects[c]
    if (r.width === 0 || r.height === 0) continue
    parts.push(q.id + ':' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height))  // :1595
  }
  if (rects.length > 0) parts.push(q.id + ':chip')
}
for (var b = 0; b < blockers.length; b++) {              // :1601-1604
  parts.push('b:' + Math.round(br.left) + ',' + ...)
}
return parts.join('|')                                    // :1605
```

- 每条批注的 `left/top` 随滚动**每帧都变**（`Math.round` 只消除亚像素抖动）。
- `blockers`（composerSeat + header）在滚动时是稳定的：header 在滚动容器外，`composerSeat` 是 `position:sticky`（宿主 CSS，见 §5），视口位置不变——所以**滚动帧的签名变化 100% 来自 quote 的 rect**。
- 签名变化 → `renderMarkers()` 走 `:1707-1712`：`overlay.textContent=''`、`numLayer.textContent=''`、`buildMarkers()`。即：**每帧删除并重建全部高亮块与编号**。

重建的隐藏成本：
- 每帧删除约 `ΣM` 个 `.dsh-ann-hl` + `N` 个 `.dsh-ann-num`，再创建同量节点（`:1726-1732`、`:1773-1800`）。`ΣM` 随批注跨行数增长（跨段/跨行引用会成倍）。
- 每个 `.dsh-ann-hl` 写 4 个内联样式（`:1728-1731`），每个 `.dsh-ann-num` 写 2 个（`:1792-1793`），加上 `textContent` 与 `appendChild` —— 触发样式失效；同一帧后续若再有布局读，就强制同步布局（layout thrashing，见 §1.7）。
- 每帧重新 `addEventListener('click', ...)` 闭包（`:1795-1799`）——虽然节点被丢弃后随 GC 回收，但每帧 N 个闭包分配仍是 GC 压力。

### 1.4 `buildMarkers()` 内的 3N 次全文档查询

```js
// client.js:1758-1771（HEAD）
var skipChip = false
var views = hostLocalRects('scrollBody')                  // :1759  ← 循环内，每批注一次
for (var vc = 0; vc < views.length; vc++) { ... }
var blockers = hostHeaderRects().concat(hostComposerRects())  // :1766 ← 循环内，每批注一次
for (var bc = 0; bc < blockers.length && !skipChip; bc++) { ... }
```

循环外（`renderMarkers`）已经算过一次 `holes = hostComposerRects().concat(hostHeaderRects())`（`:1700`），循环内又对每条批注重复：

- `hostLocalRects('scrollBody')` → `document.querySelectorAll('[class*="_scrollBody"]')`（`:1613`）→ 每条批注 1 次全文档属性子串扫描；
- `hostHeaderRects()` → `conversationColumnRange()` 里 `document.querySelector('[data-conversation-scroll]')`（`:1631`）+ `hostLocalRects('header')` 全文档扫描；
- `hostComposerRects()` → `hostLocalRects('composerSeat')` 全文档扫描（可能再回退 `querySelector('[data-composer-card]')`）。

**每帧合计**：`2 + 3N` 次全文档 `querySelectorAll`（`renderMarkers` 的 2 次 + `buildMarkers` 的 3N 次），外加 `N` 次 `querySelector('[data-conversation-scroll]')` 与 `N` 次 `querySelector('[data-composer-card]')` 回退。**N=20 → 62 次全文档查询/帧；N=50 → 152 次/帧。**

`[class*="_header"]` 这类属性子串选择器成本是 O(E)（浏览器无法用 class 索引；每个元素都要读 class 属性做子串匹配），在长会话（E 数千~上万）上单次 50–150µs 量级。

### 1.5 `quoteRects()` 的文件批注逐层样式读取

```js
// client.js:456-476（HEAD）
var rects = Array.from(range.getClientRects())            // :457
if (!saved.sourceUrl) return rects
var clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
var node = range.commonAncestorContainer
var el = node instanceof Element ? node : node.parentElement
for (; el && el !== document.body; el = el.parentElement) {   // :462
  var style = getComputedStyle(el)                            // :463  ← 逐层
  var box = el.getBoundingClientRect()                        // :464  ← 逐层
  if (/auto|scroll|hidden|clip/.test(style.overflowX)) { ... }
  ...
}
return rects.map(...).filter(...)                             // :472-475
```

- 普通正文批注：每次 `getClientRects()` 一次布局读（O(M)）。
- **文件批注**（`saved.sourceUrl`，侧边栏/文档预览）：每条批注、每次调用都会对祖先链逐层 `getComputedStyle`（强制样式解析）+ `getBoundingClientRect`（布局读），深度 `D` 典型 10–20 层。滚动帧调用 2N 次 → **2N × D 次样式/布局读**。N=20、D=15 → 600 次/帧。
- 该函数在签名和 `buildMarkers` 里各跑一次（§1.3、§1.6），文件批注场景成本翻倍。

### 1.6 `locateQuote()` 的定位成本与 2N 重复

`locateQuote()`（`:702-858`）的路径与成本：

| 分支 | 位置 | 成本 |
|---|---|---|
| 保存过 `range` 且仍连接、文本匹配 | `:721-730` | 快路径：`range.toString()`（O(引用文本长度)）+ 两次 `replace(/\s+/g,'')` 比较 |
| `saved.sourceUrl`（文件批注） | `:703-719` | `querySelectorAll(DOCUMENT_TEXT)`（全文档，`:704`）+ 每个候选 `getClientRects().length`（`:707`）+ `textContent` 全文 `indexOf`（`:715`） |
| `seqKey` 锚定 | `:732-788` | `document.querySelector('[data-chat-anchor-key="..."]')`（`:734`，全文档属性查询）+ 行 `textContent` + `allNormSpans` 线性扫描 + `rangeFromOffset` 的 `TreeWalker`（`:506`） |
| `rowHead` 行匹配 | `:789-825` | 对每行 `textContent` 拼接（`:791`）+ 归一化扫描 + `TreeWalker` |
| 全量兜底 | `:826-841` | **对 R 行逐行** `textContent`（`:832`）+ `allNormSpans` + `rangeFromOffset` |
| `[data-chat-flow]` 全文 | `:842-856` | `textContent` 整个会话流 + `rangeFromOffset` 全文 `TreeWalker` |

关键点：**签名阶段（`:1589`）和 `buildMarkers`（`:1720`）各调用一次，滚动帧 2N 次**。多数在线批注走 `saved.range` 快路径，但刷新恢复/从 localStorage 恢复、或 React 重渲染替换了文本节点后，`saved.range` 失效，就退化为每帧 O(R × 文本) 的全量扫描 —— 这正是「批注一多 + 会话一长」时卡顿最严重的组合。

### 1.7 布局读写交错（layout thrashing）

滚动帧内的顺序天然是「读 → 写 → 再读」：

1. `hostComposerRects` / `hostHeaderRects` / `quoteRects`：`getBoundingClientRect` / `getClientRects`（**读**，需要干净布局）；
2. `overlay.textContent=''` + `buildMarkers` 创建节点、写 style（**写**，使样式/布局失效）；
3. `updateChip` 的 `offsetWidth/offsetHeight`（`:2152-2153`）+ `seat.getBoundingClientRect()`（`:2154`）（**读**，写完后立即读 → 强制同步布局）；
4. 下一帧的 `getClientRects` 又要 flush 一次。

——每帧至少 1 次「写后读」的强制布局，把上面所有写成本串成一条长任务。

---

## 2. `updateChip()` 每帧成本（`:2118-2163`）

```js
function updateChip() {
  if (ui.quotes.length === 0) { chipLayer.style.display = 'none'; clearTip(chipLayer); return }
  chipLayer.textContent = ''                                // :2124  ← 每帧清空重建
  var b = document.createElement('b')                       // :2125
  b.textContent = String(ui.quotes.length)                  // :2127
  chipLayer.appendChild(b)                                  // :2128
  chipLayer.appendChild(document.createTextNode(plural(...))) // :2129
  var card = document.querySelector('[data-composer-card]') // :2130  ← 全文档属性查询
  var seat = card === null ? null : composerSeatOf(card)    // :2131  ← closest / 父链正则
  if (seat !== observedComposer) { ... }                    // :2132-2137
  if (card === null) { ... return }
  var r = card.getBoundingClientRect()                      // :2143
  ...
  chipLayer.style.display = 'flex'                          // :2151  ← 每帧写
  var w = chipLayer.offsetWidth || 80                       // :2152  ← 强制同步布局
  var h = chipLayer.offsetHeight || 24                      // :2153  ← 强制同步布局
  var top = Math.min(r.top, seat.getBoundingClientRect().top) - h - 6  // :2154 ← 布局读
  ...
  chipLayer.style.left = ... + 'px'                         // :2161
  chipLayer.style.top = top + 'px'                          // :2162  ← 每帧写
}
```

每帧固定成本：
- 1 次全文档 `querySelector('[data-composer-card]')`（属性选择器，O(E)）；
- 2 次强制同步布局（`offsetWidth`/`offsetHeight`）+ 1 次 `getBoundingClientRect`（seat）；
- 3 个子节点删除 + 3 个创建（内容只显示「N 条批注」，滚动时完全不变）；
- 2 次 style 写（位置不变时也写）。

滚动时 `composerSeat` 是 sticky、`[data-composer-card]` 也基本不动，位置通常不变——这些成本**全部是白付的**。更糟的是它发生在 `buildMarkers` 的批量写之后，直接触发一次强制布局（§1.7）。

`positionEditor()`（`:1558-1565`）在编辑模式同样每帧读 `card.offsetWidth/offsetHeight`（`:1560-1561`）并写 left/top，属于同类成本（仅 editing 模式）。

---

## 3. `MutationObserver` 流式高频（`:1311-1349`）

```js
var observer = new MutationObserver(function (mutations) {   // :1326
  if (!mutationRelevant(mutations)) return                    // :1327
  onLayoutChange()                                            // :1328  ← 每批都触发全量渲染
  ...
  if (hasRowInsert) { scheduleDecorateAll(); return }         // :1337-1343
  scheduleAssistantDecorate()                                 // :1347
})
observer.observe(document.body, {                             // :1349
  childList: true, subtree: true, characterData: true, attributes: true,
})
```

- **观察范围过大**：整个 `document.body` 子树 + `attributes`（无 `attributeFilter`）。React 每次渲染会改 `class`/`style`/`data-*`/`aria-*` 等属性、每个 token 改文本节点（`characterData`），都会进回调。源码注释（`:1332-1333`）实测「流式输出期 20s 内 245 批次、0 个 childList」——即每帧约 12 批。
- **每批都触发 `onLayoutChange()`**（`:1328`），rAF 合并后仍等于**流式期间每帧一次全量重建**（§1.3 的全部成本）。也就是说，用户没滚动、只是模型在流式吐出长回复时，主线程同样被标记重建打满，滚动交互自然被拖慢。
- `mutationRelevant()`（`:1311-1325`）对每个 mutation 的 target 做最多 6 次 `closest()`（`:1316-1319`），是 O(mutations × 祖先深度 × 选择器) 的前置开销；加上 observer 本身对 body 全子树的记录成本。
- 回调里 `hasRowInsert` 只区分出 `scheduleDecorateAll`（`:1342`），字符批次走 `scheduleAssistantDecorate`（`:1347`）——但 `onLayoutChange` 已经先跑了。

---

## 4. 旁路成本

### 4.1 `scheduleDecorateAll`（`:2731-2744`，120ms 合并）与 `decorateAll`（`:2694-2721`）

```js
function decorateAll() {                                      // :2694
  var rows = allMessageRows()                                 // :2696 ← querySelectorAll 全文档
  for (var i = rows.length - 1; i >= 0; i--) {
    var el = rows[i]
    if (el.querySelector('[data-annotation-bubble-tag]') !== null) continue   // :2700
    var b = el.querySelector('[class*="bubble"]')             // :2701
    if (b === null || !hasAnnotationBlock(b.textContent || '')) continue      // :2702 ← 整行 textContent
    ...
  }
  decorateAssistantAnnotations()                              // :2717
}
```

- 每次 `decorateAll` 对**全部消息行**做：属性查询、`[class*="bubble"]` 子串查询、`b.textContent` 拼接整行文本（长回复每行数千字符）+ `hasAnnotationBlock` 扫描 → O(R × 总文本量)。
- `decorateAssistantAnnotations()`（`:2567-2585`）再次 `assistantRows()`（`:2568`，全文档 `querySelectorAll`）+ 每行 `querySelector('[data-streaming]')` / `[data-annotation-reply-chip]` / `textContent`（`:2576-2578`），命中时还 `findPrevAnnotationItems`（`:2579` → `allMessageRows` + `indexOf`）与 `decorateAnnotationLabels`（`:2588`，`TreeWalker` + 正则 + `replaceChild`）。
- 触发源：`childList` 批次（`:1342` 立即/120ms 合并）+ **1s 轮询**（`:2747`，`kickDecorate`）持续跑；会话越长代价越大。
- 隐藏批注块的手术 `hideAnnotationBlock`（`:2369-2429`）本身也做 `TreeWalker`、`textContent`、`querySelectorAll('div,span,p')`（`:2419`）+ 逐元素 `textContent`。

### 4.2 `scheduleAssistantDecorate`（`:2552-2565`，500ms 限流）

字符批次走 500ms 前导+拖尾限流，每次仍执行完整的 `decorateAssistantAnnotations()`（全文档）。流式长回复期间每 500ms 一次全行扫描，与 §1 的每帧重建叠加。

### 4.3 1s 轮询

- `decoTimer = setInterval(decorateAll, 1000)`（`:2747`）：每秒一次全量装饰（§4.1）。
- `switchTimer = setInterval(onSessionSwitch, 1000)`（`:2820`）：每秒 `readCurrentSessionId()`（可能读 store/localStorage）+ 幂等比较；仅切换时做重活，空转成本低但持续。
- `watchInputDraft` 的 1s 重试（`:2355`）只在订阅未挂上时存在，挂上即清理，成本可忽略。

### 4.4 其他

- `applyLocale()` 订阅（`:2754-2779`）：语言切换时 `querySelectorAll('[data-annotation-bubble-tag]')` 批量改文本，一次性。
- `document.addEventListener('pointermove', onTipPointerMove, true)`（`:2183`，HEAD 对应位置）：每次指针移动写两个变量，成本可忽略（但是全局 capture 监听，热路径上仍有事件派发成本）。

---

## 5. 宿主机制：为什么标记会「慢半拍」

### 5.1 滚动容器是原生滚动

`@deepseek-ai/dsh-client-ui-conversation/lib/client.js`：

- `:20606-20609` 渲染滚动容器：`<div className={ConversationRoot_module_css_default.scrollBody} data-conversation-scroll="">…</div>`，内含 `Views`（聊天视图）与 `composerSeat`。
- CSS `:20057`（`ConversationRoot_module_css_default` 常量）：
  - `.wSkVaW_scrollBody{scrollbar-gutter:stable;flex-direction:column;flex:1;min-height:0;margin-right:2px;display:flex;overflow-y:auto}` —— **原生 `overflow-y:auto` 滚动**，滚动位置由浏览器合成线程处理。
  - `.wSkVaW_composerSeat{z-index:9;will-change:transform;overflow-anchor:none;…;position:sticky;bottom:0}` —— 输入区是滚动容器内的 **sticky** 元素，滚动时由合成器保持粘性，视口位置不变。
  - `.wSkVaW_header{…;min-height:76px;…;display:grid}` —— 会话头部在 `scrollBody` 之外（`ConversationHeader`，`:20638-20646`），不随滚动移动。
- 聊天视图（`@deepseek-ai/dsh-client-ui-chat/lib/client.js`）：
  - `ChatViewport.attach()`（`:2331-2366`）：`const scroller = list.closest("[data-conversation-scroll]") ?? list`（`:2333`）；`scroller.addEventListener("scroll", this.onScroll, { passive: true })`（`:2345`）；`ResizeObserver` 观察 column/scroller/composer（`:2354-2366`）。
  - `ChatViewport.capturePosition()`（`:2874-2911`）：主线程上 `getBoundingClientRect()` + `document.elementsFromPoint` + 行 rect 的二分查找——宿主自己也在滚动前后做同步测量。
  - 正文行是全量渲染的（`data-chat-flow` `:3638`；行元素 `data-chat-anchor-key`/`data-chat-flow-kind` `:4581-4592`）。`useVirtualizer`（`:305-379`，`directDomUpdates: true`、`directDomUpdatesMode: "transform"`、`overscan: 3`）只服务于右侧 **Turn 导航轨道**（`:440-489`），**不是正文虚拟化**——所以滚动不会卸载正文行，但长会话 DOM 元素数 E 很大，放大了所有全文档查询成本。
  - 流式输出用 `data-streaming` 标记（`:8218`、`:8372`），每个 token 更新文本/属性 → 触发插件 `MutationObserver`（§3）。自动跟随（`data-chat-following-tail` `:3631`，`foldDriver` 里写 `scrollTop` `:2516` 等）是 JS 驱动的。

### 5.2 fixed 标记层与主线程

插件的标记层完全独立于宿主滚动：

- `overlay`：`position:fixed;inset:0;pointer-events:none;z-index:900`（`:1057`）
- `numLayer`：`position:fixed;inset:0;pointer-events:none;z-index:1100`（`:1067`）
- `.dsh-ann-hl { position: fixed; z-index: 900; … }`（`:147`）
- `.dsh-ann-num { position: fixed; z-index: 940; … }`（`:149`）

fixed 元素相对**视口**定位，滚动时不会自动移动；内容滚动后，同一段文字的新视口位置必须由 JS 重新测量并写回 left/top。所以「标记跟随滚动」这件事完全依赖主线程每帧执行 §1 的整条链。

### 5.3 「慢半拍」的时间线

1. 用户滚动 → 合成线程立即位移正文（这一帧视觉上已动，不等主线程）。
2. 主线程收到 `scroll` 事件（capture，`:1308`）→ `onLayoutChange` 置位 → rAF 回调排入队列。
3. 该 rAF 内执行 `renderMarkers()`：先 flush 上一帧写造成的脏布局，再 N 次 `getClientRects`（§1.5），再做签名比较（2N 次定位），再 `textContent=''` + 重建 ~ΣM+N 个节点 + 数百次 style 写，最后 `updateChip` 又强制布局一次（§2）。
4. 若单帧累计 > 16.7ms，浏览器丢帧；rAF 回调被推到下一帧甚至更后。这期间正文已继续滚动 Δ 像素，标记仍停在上一成功测量的位置 → **视觉滞后 Δ，快速滚动时就是「慢半拍」**。
5. 重建 DOM / 写 style 让布局再次变脏，下一次 `getClientRects` 触发同步布局（§1.7），把后续帧也拖长 → 滞后累积 2–3 帧以上。
6. 同一主线程上还排着宿主自己的滚动处理（`onScroll`、`capturePosition`、ResizeObserver、流式跟随的 `scrollTop` 写入）与 React 渲染；插件每帧 5–20ms 会直接挤占它们，于是「正文滚动本身」也开始卡。

---

## 6. 量化估算（N=20 典型场景）

参数：`N=20` 条批注、每条跨 `M=2` 行、`R=200` 行、文件批注比例 20%（`D=15`）、全文档元素 `E≈5000`。

| 指标 | 每帧次数（滚动帧） | 说明 |
|---|---|---|
| 全文档 `querySelectorAll('[class*="_…"]')` | **2 + 3N = 62** | §1.4；N=50 → 152 |
| `querySelector`（`[data-conversation-scroll]`/`[data-composer-card]`/seqKey） | **1 + N + 至多 2N = 61** | §1.4 / §1.6 / §2 |
| `locateQuote` 调用 | **2N = 40** | 签名 + build；慢路径退化时每次 O(R) |
| `quoteRects` 调用 | **40** | 其中 20% 为文件批注 → 额外 8×15 = 120 次 `getComputedStyle` + 120 次 `getBoundingClientRect` |
| `range.getClientRects()` | **40** | 每次 O(M) |
| DOM 节点创建/删除 | **ΣM + N ≈ 60 + 60** | §1.3 |
| 内联 style 写 | **4ΣM + 2N + 2 + ~6 ≈ 208** | §1.3 / §2 |
| 强制同步布局 | **≥3**（updateChip 2 + seat 1；editing 时 +2） | §2 / §1.7 |
| 文本扫描（慢路径，若 range 失效） | 每帧 2N 次 × O(R × L_row) | 最坏情况 |

量级：62 次属性子串全文档查询（每次 50–150µs）≈ **3–9ms**；40 次 `getClientRects` + 布局 flush ≈ 1–3ms；40 次定位快路径 ≈ 0.5–2ms；60 节点 DOM 重建 + 208 次 style 写 + 样式重算 ≈ 2–6ms；合计 **约 6–20ms/帧**——N=20 已吞掉 16.7ms 预算的 40%–120%，N=50 时线性/平方项同时放大（3N、12N²），必然持续掉帧。若批注引用跨多行（M 大）或文件批注多（D 项），成本再乘。

> 上述为量级推理，绝对值需由 `test/marker-scroll-perf.mjs`（`perf-bench`）校准：审计时 `test/perf-baseline.json` 尚未生成（脚本存在，`--write-baseline` 未执行），回填见 §10.2。

---

## 7. 热点排行（按每帧 / 每次事件成本）

| # | 热点 | 位置（HEAD） | 每帧成本 | 备注 |
|---|---|---|---|---|
| 1 | `buildMarkers` 循环内 3N 次宿主全文档查询 | `:1759`、`:1766`、`:1749` → `:1611`/`:1656`/`:1677` | 62 次查询 @N=20 | 最直接的「批注越多越卡」来源 |
| 2 | 每帧全量清空 + 重建标记 DOM | `:1709-1712`、`:1726-1732`、`:1773-1800` | ~60 节点/帧 + 208 style 写 | 由签名每帧必变触发（`:1595`） |
| 3 | 签名阶段 2N 次定位 + rect 测量 | `:1585-1606` | 40 次 locate/quoteRects | 与 buildMarkers 重复 |
| 4 | 签名每帧必变 | `:1595` | — | 结构性根因 |
| 5 | `updateChip` 每帧重建 + 2 次强制布局 | `:2118-2163` | 3 次布局读 + 3 节点 | 位置通常不变，纯浪费 |
| 6 | `MutationObserver` 流式批次 → 全量渲染 | `:1326-1349` | 每帧 1 批 | 无 `attributeFilter`、body 全子树 |
| 7 | `quoteRects` 文件批注逐层样式 | `:462-471` | 最多 2N×D 次样式/布局读 | 文件批注场景放大 |
| 8 | `clipPath` 每帧无条件写 | `:1701`、`:1704` | 2 次 fixed 层裁剪失效 | 滚动时 holes 其实不变 |
| 9 | `decorateAll` 1s 轮询 + 120ms 合并 | `:2694-2748` | R 行 textContent/次 | 长会话线性增长 |
| 10 | `locateQuote` 慢路径全量扫描（range 失效时） | `:826-856`、`:789-825` | 2N × O(R×L) | 刷新恢复/重渲染后最坏 |
| 11 | `positionEditor` 每帧强制布局（editing） | `:1558-1565` | 2 次 | 仅编辑模式 |
| 12 | 1s `onSessionSwitch`（`readCurrentSessionId`） | `:2790-2806`、`:2820` | 1 次 | 空转成本低 |

---

## 8. 修复建议与必须保留的测试断言

> 原则：**每帧必须继续更新标记位置/可见性**（滚动跟随是规格，不是优化目标），优化的只是「不做重复工作」：查询缓存、定位缓存、DOM 复用、写前去重。

### 8.1 宿主几何元素缓存（对应 `hostLocalRects`/`hostHeaderRects`/`hostComposerRects`）

- 方案：按 CSS local 名缓存**元素**（而非 rect），`querySelectorAll` 只做一次；每帧只 `getBoundingClientRect`（读，廉价）。`conversationColumnRange` 的 `[data-conversation-scroll]` 与 `composerCard` 同样缓存元素。
- 失效时机：`childList` mutation（视图/会话重建）、`onSessionSwitch`、`window.resize` 后若选择器可能变化。
- 预期：每帧 62 次全文档查询 → 0 次（缓存命中）或 1–2 次（失效后重建）。
- 风险：
  - 元素被 React 复用但 class 变化 → 缓存命中错误元素；建议命中后仍校验 `el.isConnected`（并可选校验 `getAttribute('class')` 正则），失效则重查。
  - 视图 tab 切换（主视图 ↔ focus 视图）会换掉 `[data-conversation-scroll]`；缓存必须随 `childList` 失效，否则 `conversationColumnRange` 返回旧元素（rect 为 0）。
  - 首次查询返回 `null` 时不要永久缓存，等后续 mutation 失效后重查。
- **必须保留的断言**：
  - `test/layout-overlay.test.mjs:78-81`：`function hostLocalRects(local)`、`function hostHeaderRects()`、`function hostComposerRects()` 存在，且 `hostLocalRects('composerSeat')` 字面量保留。
  - `test/layout-overlay.test.mjs:82-85`：`renderMarkers` 切片必须含 `hostComposerRects().concat(hostHeaderRects())` 与 `clipWithHoles(holes)`。
  - `test/layout-overlay.test.mjs:88-93`：`buildMarkers` 切片必须含 `hostLocalRects('scrollBody')`、`hostHeaderRects().concat(hostComposerRects())`、`skipChip`，且不含 `overlay.appendChild(chip)`。
  - `test/layout-overlay.test.mjs:165-227`：`hostLocalRects`/`conversationColumnRange`/`renderMarkers` 会被**单独提取求值**（`Function(...)`），因此这些函数必须保持自包含：缓存只能挂在函数自身静态属性/参数上，不能引用模块级闭包外部变量（否则切片求值 ReferenceError）。
  - `test/header-scroll-browser.mjs:14-18` 的 fixture 使用 `actual_header`/`actual_scrollBody` 类名与 `data-conversation-scroll`；`hostLocalRects('scrollBody')` 的类名启发式必须保留（`data` 缺失时兜底）。

### 8.2 quote 定位 Range 缓存（对应 `locateQuote` 的 2N 次/帧）

- 方案：首次定位后把 `Range` 缓存到 quote 上；滚动帧只做存活校验，失败才重新 `locateQuote`。
- 存活校验的廉价实现：`startContainer.isConnected` + 文本未变（可用节点身份/长度/首尾采样；完整 `range.toString()` 比较是 O(引用长度)，引用很长时仍可接受但不理想）。
- 预期：滚动帧 40 次定位 → 最多 40 次 O(引用长度) 校验；不再有 O(R×文本) 全量扫描。
- 风险：
  - 插件自己的装饰会改宿主 DOM：`hideAnnotationBlock`（`:2369`）删节点、`decorateAnnotationLabels`（`:2588`）`replaceChild` 文本节点——缓存 Range 会失效，必须靠校验兜底，不能假设「滚动不会让 Range 失效」。
  - React 重渲染/流式输出会替换文本节点（`isConnected=false`），校验必须覆盖。
  - 缓存住 `Range` 会持有旧 DOM；随 quote 删除/会话切换要释放（WeakMap 以 quote 对象为键可自然回收）。
- **必须保留的断言**：
  - `test/header-scroll-browser.mjs:55-61`：滚动后 `.dsh-ann-hl` 的**位置**必须与实时 Range rect 差 < 1px（每帧跟随的规格）。
  - `test/header-scroll-browser.mjs:63-74`：滚到 header 下 marker 消失、滚回恢复 marker。
  - `test/overlay-browser.mjs:48-110`：高亮层裁剪、编号让位/隐藏、header 裁剪。

### 8.3 标记 DOM 元素池增量更新（对应每帧清空重建）

- 方案：按批注维护 `entry.hls[]` 与 `entry.chip` 池元素；每帧只更新变化的坐标/尺寸/显示状态，不删除不重建；批注删除时才释放元素。
- 预期：每帧 ~60 节点创建/删除 → 0（滚动稳态）；style 写只发生在几何变化时。
- 风险：
  - **必须每帧更新位置**（不能只在签名变化时更新，否则滚动不跟随——见 8.5）。
  - 点击监听闭包绑定的是旧 quote（`:1795-1799`）；池化后应改为按 id/dataset 查当前 quote，或为每个 entry 只注册一次并保留其 quote 引用（quote 对象被删除后要从池中移除，避免点击已删除批注）。
  - 旧元素移除时要同步清理自定义状态（如坐标缓存），避免「隐藏后坐标脏」。
  - `overlay.textContent=''` 不再执行后，任何依赖「清空」的隐式清理都不存在——需显式回收。
  - 尺寸变化（字号/换行/窗口宽度）时 rect 的 width/height 会变，池元素必须更新；用 w/h 缓存 diff 写入。
- **必须保留的断言**：
  - `test/layout-overlay.test.mjs:12-25`：`numLayer` 层存在、`z-index:1100`、`pointer-events:none`、`renderMarkers` 切片含 `numLayer.style.clipPath = overlay.style.clipPath`、`buildMarkers` 切片含 `numLayer.appendChild(chip)` 且不含 `overlay.appendChild(chip)`、`chipFloor` 逻辑保留。
  - `test/layout-overlay.test.mjs:229-235`：`buildMarkers` 切片含 `var chipFloor = col !== null ? col.top + 4 : 4` 与 `anchor.top >= chipFloor && chipTop < chipFloor`。
  - `test/overlay-browser.mjs:113-126`：编号不得跨 header 边界留下半截（skip 规则保留）。
  - `test/overlay-browser.mjs:84-88`：输入区高亮被裁剪、编号不压输入框。

### 8.4 `clipPath` 仅在变化时写（对应 `:1701`、`:1704`）

- 方案：缓存上次 `holes` 的序列化结果（或直接用 blocker 签名），相等则跳过写。`overlay.style.clipPath` 与 `numLayer.style.clipPath` 一起跳过。
- 预期：滚动稳态下每帧 2 次 fixed 层裁剪失效 → 0；窗口 resize、输入区展开（ResizeObserver）、header 高度变化时仍会写。
- 风险：
  - 签名必须包含所有会影响 holes 的量（`composerSeat`/header 的 left/top/right/bottom、窗口尺寸）；漏掉一项就会出现「输入区已变、标记层还按旧洞裁剪」。
  - 不要用「读写 `overlay.style.clipPath` 比较」来判等（读回字符串成本低但风格差）；用局部变量缓存。
- **必须保留的断言**：
  - `test/layout-overlay.test.mjs:82-85`：`renderMarkers` 切片含 `hostComposerRects().concat(hostHeaderRects())`、`clipWithHoles(holes)`。
  - `test/layout-overlay.test.mjs:17-18`：`numLayer.style.clipPath = overlay.style.clipPath` 字面量（若改为局部变量，需要同步修改测试；建议保留该赋值语句形态）。
  - `test/layout-overlay.test.mjs:179-212`：clipPath 的 polygon 内容（header 洞限定在会话列、composer 洞、fallback）。
  - `test/overlay-browser.mjs:78-88`：`clipPath`/`numClipPath` 为 `polygon`、输入区高亮被裁。
  - `test/header-scroll-browser.mjs:75-87`：resize 后 header 高度变化仍触发裁剪更新；侧边栏文件高亮不被会话列 header 挖洞裁掉。

### 8.5 `updateChip` 内容/定位拆分（对应 `:2118-2163`）

- 方案：内容（数字 + `plural` 文案）只在 `ui.quotes.length` 或语言变化时重建；定位每帧只读 `[data-composer-card]`（元素缓存）、比较 last left/top 后才写；尺寸用缓存，内容变化时再量一次 `offsetWidth/offsetHeight`（保留「先显示再量」的首帧语义）。
- 预期：每帧 3 次强制布局 → 0（滚动稳态）；chip 内容不变时零 DOM 操作。
- 风险：
  - **`test/pending-chip-position.test.mjs:58-66` 用 `Function(...)` 把 `updateChip` 源码单独求值**。HEAD 版测试只注入 `ui/document/window/chipLayer/clearTip/plural/composerObserver`；工作树已同步适配（追加注入 `composerCardEl`、拼接 `syncChipContent`/`hideChip` 源码与 `chipGeom`/`chipContentSig` 声明）。这意味着**该测试的依赖面随实现一起扩大**：后续再拆出辅助函数时必须同步注入，否则 `ReferenceError`；更稳妥的做法是把内容/定位/隐藏逻辑保持在 `updateChip` 函数体内（局部函数即可），避免每次实现调整都动测试。
  - 语言切换（`applyLocale`，`:2754`）会调用 `updateChip`，内容缓存要能被显式重置。
  - 首次显示时 `offsetWidth` 为 0 的语义要保留（`:2150-2153` 注释）：display 先 flex、再量、失败回退 80/24。
- **必须保留的断言**：
  - `test/pending-chip-position.test.mjs:75-81`：胶囊清除整个 queued dock（`bottom <= SEAT.top - 6`）、水平对齐 `CARD.right - 12`、首帧测量。
  - `test/pending-chip-position.test.mjs:92-104`：seat 不变时不重连 observer、更换 seat 时 disconnect 一次。
  - `test/pending-chip-position.test.mjs:120-149`：空间不足隐藏、card 消失隐藏、只清理 chip 自己的面板（`clearTip(chipLayer)`）。
  - `test/layout-overlay.test.mjs:27-34`：`onLayoutChange` 切片含 `updateChip()`、`new ResizeObserver(onLayoutChange)`、`composerObserver.disconnect()`。
  - `test/layout-overlay.test.mjs:45-75`：`updateChip` 切片含 `clearTip(chipLayer)`、不含 `tipLayer.textContent = ''`；全文件 `tipLayer.textContent = ''` 恰好 2 处。
  - `test/pending-chip-browser.mjs`：真实浏览器里 chip 位于 queue dock 之上、英文文案、窄视口边界（`:40-121`）。

### 8.6 `MutationObserver` 降噪（对应 `:1326-1349`）

- 方案（按风险从低到高）：
  1. `attributeFilter` 限定到真正影响布局/装饰的属性（如 `class`、`style`、`data-streaming`、`data-chat-flow-kind`），过滤 `aria-*`/`data-*` 噪声；
  2. 把 `onLayoutChange` 与「装饰」拆成两条 dirty 通道：`characterData` 批次只标记 decorations dirty（500ms 限流已存在），不立即触发 `renderMarkers`；
  3. 流式期间检测 `[data-streaming]`，把标记重建限流到 ~100ms；流式结束后补一次全量。
- 预期：流式期间每帧一次全量重建 → 每 100–500ms 一次；滚动不再与流式叠加。
- 风险：
  - 降噪过度会漏掉真正改变几何的变化（输入区展开、header 高度、消息行插入、折叠展开）——保留 `ResizeObserver`（`composerObserver`，`:2102-2104`）、`window.resize`、`scroll` 这些直接触发源作为兜底。
  - `mutationRelevant` 的 `closest` 排除列表（`:1316-1319`）必须保留，否则插件自己的 DOM 写入会自激（源码注释明确提到过自激死循环）。
  - 流式期间若用户正在创建批注（选区/工具条），不能把 `onLayoutChange` 完全停掉，否则工具条不跟随。
- **必须保留的断言**：
  - `test/layout-overlay.test.mjs:32-33`：`new ResizeObserver(onLayoutChange)`、`composerObserver.disconnect()`。
  - `test/layout-overlay.test.mjs:55-63`：updateChip 的隐藏分支只能 `clearTip(chipLayer)`（防止高频布局触发误清面板）。
  - `test/overlay-browser.mjs`、`test/header-scroll-browser.mjs` 的滚动/裁剪行为（§8.1–8.5 所列）。

### 8.7 其他建议（按收益排序）

1. **`decorateAll` 行级去重**：用元素身份 `WeakSet` 记录已装饰行（React 重渲染会换元素，可自动重扫），避免每 1s 对 R 行做 `textContent` 拼接全量扫描。保留 `data-annotation-bubble-tag` 存在性判断作为正确性兜底。
2. **`assistantRows()`/`allMessageRows()` 结果缓存**：同一帧内多处调用（`locateQuote`、`decorateAssistantAnnotations`、`findPrevAnnotationItems`）重复全文档查询；可按帧缓存。
3. **`locateQuote` 的 seqKey 元素缓存**：`document.querySelector('[data-chat-anchor-key=…]')`（`:734`）每帧全文档属性查询，缓存元素引用并在 `childList` 时失效。
4. **碰撞检测（`:1777-1790`，12 × placed）**：N 大时 O(12N²)；可先按 top/18 分桶，或接受现状（N<100 时影响小于查询成本）。
5. **`positionEditor`**：编辑卡尺寸在打开后通常固定，`offsetWidth/offsetHeight`（`:1560-1561`）可缓存，内容变化（error 文本、note 长度）时再量一次。
6. **避免每帧重建 `Range`**：`quoteRects` 每帧 `Array.from(range.getClientRects())`（`:457`）不可避免；但 `map/filter` 产生的新数组与 `DOMRect`（`:472-475`）可改为原地复用/数值比较，减少分配。
7. **架构级（不建议短期采用）**：把标记层移入滚动内容（相对内容列 `absolute` 定位），让合成线程直接带动标记，彻底消除每帧 JS 跟随。代价：侵入宿主 React 树、易被重渲染清除、`clipPath`/`composerSeat` 坐标体系重算、所有测试断言需重写——仅作为长期方向记录。

---

## 9. 与并行修复（工作树现状）的对照与遗漏风险

> 审计期间工作树持续变化：`client.js` 从 +50/−20 增长到 +352/−134，`test/layout-overlay.test.mjs`、`test/pending-chip-position.test.mjs` 已适配新实现，并新增未跟踪的 `test/marker-scroll.test.mjs`（行为回归）与 `test/marker-scroll-perf.mjs`（基准）。以下基于审计时读到的实现片段，供 Lead 自查（行号以工作树为准，随时间漂移）。

**已出现的方向**（与 §8 一致）：
- `markersSignature` 只保留 `blockers`，`clipPath` 移入 `if (sig !== markersSig)`（工作树 `renderMarkers`）；
- `hostLocalEls` 按 local 名缓存元素、`conversationViewEl`/`composerCardEl` 缓存、`invalidateHostLocalRects` 在 `hasRowInsert` 与 `onSessionSwitch` 调用；
- 元素池：`markerEntries` / `markerEntryFor` / `hlAt` / `chipAt` / `placeMarkerEl` / `hideMarkerEl` / `clearMarkers`，用 `transform` 定位、`display` 隐藏；
- `locateQuoteCached` + `rangeAlive` 缓存 Range；
- `updateChip` 拆出 `syncChipContent` + `chipGeom` 尺寸缓存。

**需要重点验证 / 可能遗漏的点**：

1. **`style.top`/`style.left` 断言与 transform 定位冲突（当前唯一未被适配的既有浏览器测试，且 CI 会跑）**：`test/header-scroll-browser.mjs:55-61` 通过 `parseFloat(hl.style.top)` 与实时 Range rect 比较（容差 1px）。元素池改用 `transform: translate(x,y)` 且把 `left/top` 固定为 `0px` 后（工作树 `placeMarkerEl`：`el.style.left='0px'; el.style.top='0px'; el.style.transform='translate(x,y)'`），`hl.style.top` 恒为 `0`，该 `waitForFunction` 会超时、测试红。`.github/workflows/ci.yml:76` 明确运行 `node test/header-scroll-browser.mjs`（`BASELINE_CLIENT=/tmp/annotation-1.4.10-client.js`），因此这不是可选测试。三种修法：① 测试改读 `getBoundingClientRect().top` 或解析 `transform`；② `placeMarkerEl` 保留 `left/top` 定位（仅变化时写，fixed 写坐标触发布局，但比每帧重建便宜一个量级）；③ 在 `style.top` 上同步维护一个仅供测试/调试的镜像值（不推荐，语义脏）。无论哪种，**CI 必须同时覆盖两者，避免一个绿一个红**。
2. **`pending-chip-position.test.mjs` 的 `Function` 求值（工作树已适配，风险转为耦合漂移）**：工作树 diff 已把 `composerCardEl`、`syncChipContent`、`hideChip` 与 `chipGeom`/`chipContentSig` 声明注入测试作用域，测试不会 `ReferenceError`。但它意味着**测试与实现拆分方式强耦合**：后续再拆出辅助函数、改参数顺序或改函数名都要同步改测试。建议把内容/定位/隐藏逻辑继续保留在 `updateChip` 函数体内（局部函数即可），只在确实必要时才让测试注入更多符号；同时保留 HEAD 版测试的行为断言（§8.5/§10.1）。
3. **`markersSignature` 去掉 quote 后的「非滚动变化」刷新路径**：签名现在只反映 blockers。若某些变化不改变 blockers、也不改变 `ui.quotes`，但改变 quote 的 rect（例如宿主字体加载完成、消息折叠展开导致行高变化、图片加载撑高行、窗口宽度变化但 header/composer 尺寸恰好不变），`renderMarkers` 每帧仍会 `buildMarkers`（当前工作树是每帧无条件 `buildMarkers`），所以**只要 `buildMarkers` 每帧都跑且每帧都重建 rect，就不会漏**。请确认工作树 `renderMarkers` 确实每帧调用 `buildMarkers`（当前是），而不是「仅签名变化时」——否则 header-scroll 的 `waitForFunction` 会超时、滚动不跟随。
4. **`rangeAlive` 的每帧成本**：每帧每条批注调用 `range.toString()` + 两次 `replace(/\s+/g,' ')` + 比较（`O(L_quote)`）。引用文本很长（跨段落大段引用）时，N=20、L=2000 → 每帧 4 万字符扫描，仍可能 1–3ms。建议在 `rangeAlive` 里加节点身份/长度快判，或由 `characterData` mutation 维护「失效文本节点集合」，只在集合命中时才做全文比较。
5. **缓存元素失效与 detached 校验**：`hostLocalEls` 缓存的是元素引用，`invalidateHostLocalRects` 只在 `hasRowInsert`（`childList`）与 `onSessionSwitch` 调用；若宿主**复用元素但改 class**（无 childList），缓存仍会把该元素当命中（`hostLocalRects` 不再做 class 正则复验），可能把错误元素纳入 clipPath 洞。建议在 `hostLocalRects` 内保留 `getAttribute('class')` 正则校验（字符串读，廉价）或至少校验 `el.isConnected`。
6. **`conversationViewEl.cache` 的首次 null**：若插件首次 `renderMarkers` 早于视图挂载（返回 `null`），缓存会一直为 `null`，直到下一次 `invalidateHostLocalRects`（childList mutation 会触发，通常没问题）；但若是「视图已挂载、插件后加载」的时序则首次查询不会 null。建议 null 结果不缓存（`cache === undefined` 判断改为「结果非空才缓存」）以消除时序依赖。
7. **元素池与 overlay 的「外部节点」**：旧实现每帧 `overlay.textContent=''`；池化后不再清空。`test/header-scroll-browser.mjs:80-86` 会向 overlay 手工插入 `#sidebar-probe` 并断言其可见——池化方案下 probe 会保留（更好）；但要确保插件卸载/`clearMarkers` 时不会误删非池节点，或至少测试不依赖清空语义。
8. **碰撞循环仍 O(N²)**：`placed` 线性扫描 × 12 次重试（`:1777-1790`，工作树同逻辑）。N=50 时 30,000 次比较/帧，虽比全文档查询便宜，但可顺手按 `top/18` 分桶。
9. **`decorateAll` 与 `MutationObserver` 尚未降噪**：工作树 diff 未触及 `decorateAll`（1s 全量）与 observer 的 `attributes`/`characterData` 面；流式长回复期间每帧 `onLayoutChange` 仍会触发（虽然 `renderMarkers` 已轻量化）。
10. **`hideChip` 的 `clearTip(chipLayer)` 每帧调用**：`updateChip` 隐藏分支每帧 `clearTip(chipLayer)`（工作树 `hideChip`），`clearTip` 会写 `tipLayer.textContent`（即使面板不存在也是 DOM 写）——若 chip 每帧因空间不足隐藏，会反复写共享容器。可加「tipOwner 非 chipLayer 时不动」的短路（`clearTip` 已有 owner 判断，但 `tipOwner === chipLayer` 时每帧清空一次；清空空容器成本低，可接受）。
11. **`placeMarkerEl` 的 `transform` 与 `will-change`**：fixed + transform 每帧变化会创建/维护合成层；大量标记元素各自成层可能增加内存/光栅化成本。可考虑给 `.dsh-ann-hl`/`.dsh-ann-num` 加 `will-change: transform` 仅在滚动期间（或维持现状：数量级 N×M 通常 < 100，可接受）。需实测确认。
12. **新增测试 `test/marker-scroll.test.mjs`（未跟踪）**：审计时确认其 harness 用可变 stub 几何驱动**真实** `renderMarkers`/`buildMarkers`（源码切片 + `Function` 求值，属行为断言），并断言「Range 缓存生效（慢路径计数）」「几何变化只更新池元素」等。但**旧 `header-scroll-browser.mjs` 仍是旧断言**（见第 1 点）。合并前请确认：新测试后续断言没有直接读取 `__annGeom`/`markerEntries` 这类实现内部状态（否则会把实现细节固化成规格）；新旧测试在 CI 中同时通过；测试文件改动本身就是规格的一部分，建议在 PR 描述里列出「哪些断言因实现变化而调整、行为是否等价」。

---

## 10. 复测方法与基线对齐

### 10.1 现有测试（行为规格）

```powershell
node --test test/layout-overlay.test.mjs test/pending-chip-position.test.mjs test/shared-listeners.test.mjs
# Lead 新增（未跟踪）：node --test test/marker-scroll.test.mjs
# 浏览器（需要 PLAYWRIGHT_MODULE 指向可用 playwright）
node test/overlay-browser.mjs
node test/header-scroll-browser.mjs
node test/pending-chip-browser.mjs
```

`package.json` 的 `test` 脚本是 `node --test test/*.test.mjs`（不含浏览器/基准脚本）；CI 在 `.github/workflows/ci.yml` 中单独运行浏览器测试（`:76` `header-scroll-browser.mjs`、`:78` `overlay-browser.mjs`）。因此 §9 第 1 点的 `header-scroll-browser.mjs` 断言冲突会直接红 CI。

重点回归：
- `header-scroll-browser.mjs`：滚动后标记位置误差 < 1px、header 下 marker 消失、滚回恢复、resize 后裁剪更新、侧边栏 probe 不被裁。**注意 §9 第 1 点：该测试读 `hl.style.top`，与 transform 定位不兼容，合并前必须处理。**
- `overlay-browser.mjs`：输入区/头部裁剪、编号让位、半截残影、清单浮窗、删除联动。
- `pending-chip-position.test.mjs`：chip 定位/dock 避让/observer 不抖动。
- `marker-scroll.test.mjs`（新增）：元素池滚动跟随/可见性更新；确认其为行为断言。

审计时（工作树已有 Lead 修复）在受限沙箱里用单进程 `node test/<file>.mjs` 运行：`layout-overlay` 13/13、`pending-chip-position` 8/8、`shared-listeners` 8/8 通过。`node --test <files>` 会因 `spawn EPERM`（沙箱禁止带管道 stdio 的子进程）失败，这是环境限制，不是测试失败；CI 上不受影响。

### 10.2 基线（`perf-bench` / `test/marker-scroll-perf.mjs`）

审计时 `test/perf-baseline.json` **尚未生成**，但基准脚本已存在于工作树（未跟踪）：`test/marker-scroll-perf.mjs`（`perf-bench` 产出）。其测量维度与本报告的热点判定直接对应：

- **插件 rAF 回调执行耗时 p50/p95/max**：`page.addInitScript` 在 document 创建前包装 `requestAnimationFrame`，直接量化 `renderMarkers()` + `updateChip()` 每帧占用主线程的时间——对应 §1/§2 的每帧成本。
- **滚动期间 rAF 帧间隔 p50/p95/max**：对应 §1.7 的掉帧/滞后。
- **longtask**（`PerformanceObserver` 条目数与总时长）：对应 §7 排行 1–5 的长任务。
- **DOM 重建量**：观察 `[data-annotation-overlay]` / `[data-annotation-num-layer]` 子树的 `childList` mutation 条数与 `addedNodes` 节点数——**这是「每帧整体清空重建」（§1.3）的直接量化**；修复后该计数应趋近 0（只在批注增删时非零）。
- **滞后量**：滚动期间 `.dsh-ann-hl` 与原文 Range 的 top/left 偏差；滚动停止后标记追上原文所需帧数、首帧/稳态偏差——对应 §5.3「慢半拍」。
- 规模默认 `N = 5/20/50`、`rows=36`、`frames=120`（可用 `--n` / `--frames` / `--rows` 调整）。

回填方式：运行 `node test/marker-scroll-perf.mjs --write-baseline` 生成 `test/perf-baseline.json` 后，在本文 §6 表格后追加「实测对照」小节，逐项引用基线数字（N=20 的 rAF 回调耗时、longtask、overlay/numLayer mutation 数、滞后帧数）并与 §6 估算对照；若基线显示「长任务集中在 rAF 内」，§7 排行第 1/2 项优先级不变。`test/overlay-browser.mjs` / `test/header-scroll-browser.mjs` 的 `waitForFunction` 等待时长也可作为「标记跟上滚动」的定性指标。

### 10.3 手动复现要点

- Chrome DevTools → Performance：录制「滚动 + 流式输出」场景，看 `Recalculate Style`/`Layout` 是否集中在 `onLayoutChange` 的 rAF 回调内；`Layout` 每帧 1 次以上即 §1.7 成立。
- 断点/打点：`renderMarkers` 内记录 `markersSignature` 前后字符串长度（滚动时签名每帧变化）、`buildMarkers` 内统计 `document.querySelectorAll` 调用次数（用 monkey-patch 计数）——可直接验证 62 次/帧的估算。

---

## 附录 A：关键行号索引（HEAD `48eac63`）

| 主题 | 行号 |
|---|---|
| CSS `.dsh-ann-hl` / `.dsh-ann-num`（fixed） | `:147-156` |
| `host` / `overlay` / `numLayer` 创建 | `:1052-1068` |
| `onLayoutChange`（rAF 合并） | `:1267-1307` |
| `window scroll` capture / `resize` | `:1308-1309` |
| `mutationRelevant` | `:1311-1325` |
| `MutationObserver` 注册/回调 | `:1326-1349` |
| `positionEditor` | `:1558-1565` |
| `markersSignature` | `:1585-1606` |
| `hostLocalRects` | `:1611-1624` |
| `conversationColumnRange` | `:1630-1648` |
| `hostHeaderRects` | `:1656-1672` |
| `hostComposerRects` | `:1677-1684` |
| `clipWithHoles` | `:1687-1696` |
| `renderMarkers` | `:1698-1713` |
| `buildMarkers` | `:1715-1804` |
| `quoteRects` | `:456-476` |
| `locateQuote` | `:702-858` |
| `assistantRows` | `:482-489` |
| `allMessageRows` | `:495-501` |
| `updateChip` | `:2118-2163` |
| `watchInputDraft` / 1s 重试 | `:2346-2362` |
| `hideAnnotationBlock` | `:2369-2429` |
| `scheduleAssistantDecorate` | `:2552-2565` |
| `decorateAssistantAnnotations` | `:2567-2585` |
| `decorateAnnotationLabels` | `:2588-2636` |
| `decorateAll` | `:2694-2721` |
| `scheduleDecorateAll` | `:2731-2744` |
| `kickDecorate` / 1s `decorateAll` | `:2745-2748` |
| `onSessionSwitch` | `:2790-2806` |
| `switchTimer`（1s） | `:2820` |

## 附录 B：宿主源码索引（DSH 0.2.2-rc.1）

| 主题 | 文件:行 |
|---|---|
| 滚动容器 JSX（`data-conversation-scroll`） | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js:20606-20609` |
| `composerSeat` JSX | 同上 `:20592-20598` |
| 会话头部 JSX | 同上 `:20638-20646` |
| `.wSkVaW_scrollBody{overflow-y:auto}` / `.wSkVaW_composerSeat{position:sticky;bottom:0}` / `.wSkVaW_header` | 同上 `:20057`（CSS 常量行） |
| `ChatViewport.attach`（scroll 监听 / ResizeObserver） | `@deepseek-ai/dsh-client-ui-chat/lib/client.js:2331-2366` |
| `ChatViewport.capturePosition`（主线程几何测量） | 同上 `:2874-2911` |
| `data-chat-flow` 容器 | 同上 `:3632-3638` |
| 行元素属性（`data-chat-anchor-key`/`data-chat-flow-kind`） | 同上 `:4581-4592` |
| 流式 `data-streaming` | 同上 `:8218`、`:8372` |
| Turn 导航轨道 `useVirtualizer`（仅右侧轨道） | 同上 `:305-379`、`:440-489` |
| 跟随尾部滚动 `data-chat-following-tail` | 同上 `:3631` |
