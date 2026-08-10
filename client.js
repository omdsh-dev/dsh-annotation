// annotation-for-dsh 的浏览器端 half（client bundle）。
//
// 手写 CJS + ModuleLoader 包装（同 dsh-external navbar/greeter 模式，零构建
// 步骤）：纯 DOM 自渲染，无任何 @deepseek-ai 值导入（bundle purity gate 合规）；
// cordis 服务经 exports.inject 的字符串名接入（sessions / conversation）。
//
// v1.3.x · 自包含批注流（取代 v0.9 chip 设计与 v1.0 发送面板）：
//   1. 选中助手文字 → 工具条「批注」→ 写批注（可留空 = 仅标记原文）
//   2. 保存后原文亮蓝编号 + 高亮（纯视觉，不弹窗）；跨消息/跨回合连续累积
//   3. 输入框旁「批注 ×N」标签：悬浮可见全部内容、可逐条删除
//   4. 回车发送：capture 阶段拦截 Enter（IME 守卫对齐官方 InputBar：isComposing /
//      keyCode 229 + compositionend 后短延迟 latch）→ 批注块 prepend 进草稿
//      （setDraft，不覆盖用户文字）→ composer 正常提交
//   5. 用户气泡不显示批注块：MutationObserver 微任务阶段（绘制前）按最后一个
//      「提问：」切掉批注块、贴「批注 ×N」标签（hover 可见）；1s 轮询兜底 +
//      历史消息自动修复（用户气泡是 MessageText 单文本节点，非 markdown）
//   6. 回复逐条对照：批注块末尾注入格式指令，模型按「Annotation N：…」逐条
//      回应；回复渲染完成（data-streaming 移除）后把「Annotation N：」替换为
//      可悬浮芯片（数据取最近一条带标签用户消息的 tag.__annotationItems，刷新
//      自动重建；改 DOM 前先快照 TreeWalker 收集的文本节点再逐个替换，遍历
//      中途 replaceChild 会让 walker 指针失效）
//
// 消息格式：我批注了以下 N 处内容…\n\n1. 原文\n   批注：…\n\n
//           请用「Annotation 1：…」…\n\n提问：
// （分隔标记用「提问：」而非「问题：」——标题行「回答我的问题：」里也含它，
//   气泡隐藏手术会误命中）
//
// 不依赖发送完成事件链：watchInputDraft 在初始化时会话未加载时会失效，仅作
// 暂存入口；气泡装饰走 MutationObserver + 轮询。
//
// 判别式与 dsh-external/navbar 一致：助手行 = [data-time-hover-root] 且不含
// user bubble（[class*="bubble"]）。
window.__ModuleLoader__.load({
  // 必须与 package.json "name" 完全一致，否则 client-modules 报：
  // bundle loaded without registering "@dsh-external/dsh-annotation"
  id: '@dsh-external/dsh-annotation',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    // ============================== 样式 ==============================
    var STYLE_ID = 'annotation-for-dsh-style'
    if (document.getElementById(STYLE_ID) === null) {
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '[data-annotation-for-dsh] { all: initial; }',
        '[data-annotation-for-dsh] * { box-sizing: border-box; }',
        '.dsh-ann-bar { position: fixed; z-index: 1200; display: flex; align-items: center;',
        '  gap: 2px; padding: 4px; border-radius: 12px;',
        '  border: 1px solid var(--dsw-alias-border-inverted);',
        '  background: var(--dsw-specific-menu, #2c2c2e);',
        '  box-shadow: var(--dsw-shadow-lv3);',
        '  font-family: var(--dsw-font-family, system-ui);',
        '  animation: dsh-ann-pop .12s var(--ds-ease-in-out, ease); }',
        '@keyframes dsh-ann-pop { from { opacity: 0; transform: translateY(3px); }',
        '  to { opacity: 1; transform: none; } }',
        '.dsh-ann-ghost { display: inline-flex; align-items: center; gap: 5px; height: 28px;',
        '  padding: 0 10px; border: none; border-radius: 14px; background: transparent;',
        '  color: var(--dsw-alias-label-primary); font-family: inherit;',
        '  font-size: 12px; line-height: 18px; cursor: pointer; }',
        '.dsh-ann-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-ann-ghost:disabled { opacity: .45; cursor: default; }',
        '.dsh-ann-ghost svg { width: 14px; height: 14px; }',
        '.dsh-ann-action { display: inline-flex; align-items: center; gap: 5px; height: 28px;',
        '  padding: 0 12px; border: none; border-radius: 14px;',
        '  background: var(--dsw-alias-button-primary-fill);',
        '  color: var(--dsw-alias-label-primary-foreground);',
        '  font-family: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }',
        '.dsh-ann-action:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }',
        '.dsh-ann-action:disabled { opacity: .4; cursor: default; }',
        '.dsh-ann-action svg { width: 14px; height: 14px; }',
        '.dsh-ann-icon { display: inline-flex; align-items: center; justify-content: center;',
        '  width: 28px; height: 28px; padding: 0; border: none; border-radius: 28px;',
        '  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }',
        '.dsh-ann-icon:hover { background: var(--dsw-alias-interactive-bg-hover);',
        '  color: var(--dsw-alias-label-secondary); }',
        '.dsh-ann-icon svg { width: 14px; height: 14px; }',
        '.dsh-ann-card { position: fixed; z-index: 1201; width: 400px;',
        '  max-width: calc(100vw - 16px); padding: 12px; border-radius: 12px;',
        '  border: 1px solid var(--dsw-alias-border-inverted);',
        '  background: var(--dsw-specific-menu, #2c2c2e);',
        '  box-shadow: var(--dsw-shadow-lv3);',
        '  font-family: var(--dsw-font-family, system-ui);',
        '  animation: dsh-ann-pop .12s var(--ds-ease-in-out, ease); }',
        '.dsh-ann-card-head { display: flex; align-items: center; justify-content: space-between;',
        '  margin-bottom: 8px; }',
        '.dsh-ann-card-title { font-size: 13px; font-weight: 600;',
        '  color: var(--dsw-alias-label-primary); }',
        '.dsh-ann-quote { font-size: 12px; line-height: 1.55;',
        '  color: var(--dsw-alias-label-tertiary);',
        '  border-left: 2px solid var(--dsw-alias-border-inverted);',
        '  background: var(--dsw-alias-bg-layer-1);',
        '  border-radius: 0 8px 8px 0; padding: 6px 10px; margin-bottom: 8px;',
        '  max-height: 72px; overflow: hidden; word-break: break-word;',
        '  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }',
        '.dsh-ann-quotes { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px;',
        '  max-height: 150px; overflow-y: auto; }',
        '.dsh-ann-qitem { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px;',
        '  border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }',
        '.dsh-ann-qnum { flex: none; display: inline-flex; align-items: center; justify-content: center;',
        '  width: 16px; height: 16px; margin-top: 1px; border-radius: 8px;',
        '  background: var(--dsw-alias-text-accent, #4c9aff); color: #fff;',
        '  font-size: 10px; font-weight: 700; }',
        '.dsh-ann-qbody { flex: 1; min-width: 0; }',
        '.dsh-ann-qtext { font-size: 12px; line-height: 1.5;',
        '  color: var(--dsw-alias-label-tertiary); max-height: 36px; overflow: hidden;',
        '  word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2;',
        '  -webkit-box-orient: vertical; }',
        '.dsh-ann-qnote { font-size: 11px; line-height: 1.5; margin-top: 2px;',
        '  color: var(--dsw-alias-label-secondary); max-height: 34px; overflow: hidden;',
        '  word-break: break-word; white-space: pre-wrap; display: -webkit-box;',
        '  -webkit-line-clamp: 2; -webkit-box-orient: vertical; }',
        '.dsh-ann-qdel { flex: none; display: inline-flex; align-items: center; justify-content: center;',
        '  width: 18px; height: 18px; padding: 0; border: none; border-radius: 9px;',
        '  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }',
        '.dsh-ann-qdel:hover { background: var(--dsw-alias-interactive-bg-hover);',
        '  color: var(--dsw-alias-label-secondary); }',
        '.dsh-ann-qdel svg { width: 10px; height: 10px; }',
        '.dsh-ann-input { width: 100%; min-height: 64px; padding: 8px 10px;',
        '  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;',
        '  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);',
        '  font-family: inherit; font-size: 13px; line-height: 20px;',
        '  outline: none; resize: vertical; }',
        '.dsh-ann-input:focus { border-color: var(--dsw-alias-text-accent, #4c9aff); }',
        '.dsh-ann-input::placeholder { color: var(--dsw-alias-label-dimmed); }',
        '.dsh-ann-row { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }',
        '.dsh-ann-cancel { display: inline-flex; align-items: center; height: 28px; padding: 0 12px;',
        '  border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;',
        '  background: transparent; color: var(--dsw-alias-label-primary);',
        '  font-family: inherit; font-size: 12px; cursor: pointer; }',
        '.dsh-ann-cancel:hover { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-ann-error { color: var(--dsw-alias-state-error-primary, #ff7a7a);',
        '  font-size: 12px; margin-top: 8px; word-break: break-word; }',
        '.dsh-ann-hl { position: fixed; z-index: 900; background: rgba(255, 195, 0, .15);',
        '  border-radius: 2px; pointer-events: none; }',
        '.dsh-ann-num { position: fixed; z-index: 940; display: inline-flex; align-items: center;',
        '  justify-content: center; min-width: 16px; height: 16px; padding: 0 4px;',
        '  border-radius: 8px; border: 1px solid rgba(255, 255, 255, .3);',
        '  background: var(--dsw-alias-text-accent, #4c9aff); color: #fff;',
        '  font-family: var(--dsw-font-family, system-ui); font-size: 10px; font-weight: 700;',
        '  box-shadow: 0 1px 4px rgba(0,0,0,.35); pointer-events: none; }',
      ].join('\n')
      document.head.appendChild(style)
    }

    // ============================== 工具 ==============================
    // 助手行判别：0810 snapshot 起助手消息行 = ChatNodeSeat 上的
    // data-chat-flow-kind="assistant-step"（旧版 data-time-hover-root 已不再
    // 出现在助手消息主体上，只留在用户行与 turn 尾节点）；保留旧判别式兜底
    // 兼容回滚旧 snapshot，并排除新版 data-turn-tail 误判。
    function isAssistantRow(el) {
      if (el.matches('[data-chat-flow-kind="assistant-step"]')) return true
      return el.hasAttribute('data-time-hover-root')
        && el.querySelector('[class*="bubble"]') === null
        && !el.hasAttribute('data-turn-tail')
    }

    function assistantRowOf(node) {
      var el = (node instanceof Element) ? node : (node !== null ? node.parentElement : null)
      while (el !== null && el !== document.body) {
        if (el.hasAttribute('data-chat-flow-kind')) {
          return el.getAttribute('data-chat-flow-kind') === 'assistant-step' ? el : null
        }
        if (el.hasAttribute('data-time-hover-root')) {
          return isAssistantRow(el) ? el : null
        }
        el = el.parentElement
      }
      return null
    }

    function assistantRows() {
      var modern = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
      if (modern.length > 0) return Array.prototype.slice.call(modern)
      return Array.prototype.slice.call(document.querySelectorAll('[data-time-hover-root]'))
        .filter(isAssistantRow)
    }

    /** 全部消息行（用户 + 助手 + 其它节点）：新版走 data-chat-flow-kind，
     *  旧版回退 data-time-hover-root。用于气泡装饰、批注条目回溯。 */
    function allMessageRows() {
      var modern = document.querySelectorAll('[data-chat-flow-kind]')
      if (modern.length > 0) return Array.prototype.slice.call(modern)
      return Array.prototype.slice.call(document.querySelectorAll('[data-time-hover-root]'))
    }

    /** 由字符偏移在元素内构造 Range（跨文本节点）。 */
    function rangeFromOffset(el, offset, length) {
      var nodes = []
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      var n
      while ((n = walker.nextNode()) !== null) nodes.push(n)
      var pos = 0
      for (var i = 0; i < nodes.length; i++) {
        var len = (nodes[i].nodeValue || '').length
        if (offset < pos + len) {
          var range = document.createRange()
          range.setStart(nodes[i], offset - pos)
          var remain = length
          var j = i
          var inner = offset - pos
          while (remain > 0) {
            var l = (nodes[j].nodeValue || '').length
            var take = Math.min(remain, l - inner)
            remain -= take
            if (remain === 0) { range.setEnd(nodes[j], inner + take); break }
            j++
            inner = 0
          }
          return range
        }
        pos += len
      }
      return null
    }

    function findRangeIn(el, quote) {
      var full = ''
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      var n
      while ((n = walker.nextNode()) !== null) full += n.nodeValue || ''
      var start = full.indexOf(quote)
      if (start === -1) return null
      return rangeFromOffset(el, start, quote.length)
    }

    /** 空白完全剥离匹配：返回 quote 在 full 中的所有原始偏移区间 [{start,end}]。
     *  解决选区文本跨块级元素（GenUI 表格单元格等）带出 \n、而 DOM textContent
     *  无此空白导致的匹配失败（此前会掉进宽松匹配命中旧轮次）。 */
    function allNormSpans(full, quote) {
      var nq = quote.replace(/\s+/g, '')
      if (nq === '') return []
      var nf = ''
      var map = []
      for (var i = 0; i < full.length; i++) {
        if (!/\s/.test(full[i])) { nf += full[i]; map.push(i) }
      }
      var out = []
      var idx = nf.indexOf(nq)
      while (idx !== -1) {
        out.push({ start: map[idx], end: map[idx + nq.length - 1] + 1 })
        idx = nf.indexOf(nq, idx + 1)
      }
      return out
    }

    function findNormSpan(full, quote) {
      var spans = allNormSpans(full, quote)
      return spans.length > 0 ? spans[0] : null
    }

    function allPositionsOf(el, quote) {
      var full = el.textContent || ''
      var out = []
      var idx = full.indexOf(quote)
      while (idx !== -1) {
        out.push(idx)
        idx = full.indexOf(quote, idx + 1)
      }
      return out
    }

    function ctxScore(full, pos, len, ctx) {
      if (ctx === null) return 0
      var before = full.slice(Math.max(0, pos - 24), pos)
      var after = full.slice(pos + len, pos + len + 24)
      var s = 0
      for (var i = 0; i < Math.min(before.length, ctx.before.length); i++) {
        if (before[i] === ctx.before[i]) s++
      }
      for (var j = 0; j < Math.min(after.length, ctx.after.length); j++) {
        if (after[j] === ctx.after[j]) s++
      }
      return s
    }

    /** 由 Range 起点算出它在元素文本内的绝对字符偏移（真实位置）。 */
    function offsetOfRangeInRow(row, range) {
      try {
        var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        var n
        var pos = 0
        while ((n = walker.nextNode()) !== null) {
          var len = (n.nodeValue || '').length
          if (n === range.startContainer) return pos + range.startOffset
          pos += len
        }
      } catch (_) { /* fallthrough */ }
      return -1
    }

    /** 宽松定位：token 式匹配，双向容忍空白差异。 */
    function findRangeFlexible(el, quote) {
      var qNorm = quote.replace(/\s+/g, ' ').trim()
      if (qNorm === '') return null
      var tokens = qNorm.split(' ').filter(function (t) { return t !== '' })
      if (tokens.length === 0) return null
      var nodes = []
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      var n
      while ((n = walker.nextNode()) !== null) nodes.push(n)
      var stream = []
      for (var i = 0; i < nodes.length; i++) {
        var text = nodes[i].nodeValue || ''
        for (var k = 0; k < text.length; k++) stream.push({ node: nodes[i], offset: k, ch: text[k] })
      }
      var t = 0
      var ti = 0
      var startNode = null
      var startOff = 0
      var endNode = null
      var endOff = -1
      var seenGap = false
      for (var s = 0; s < stream.length && t < tokens.length; s++) {
        var ch = stream[s].ch
        var isWs = /\s/.test(ch)
        if (isWs) {
          if (ti === 0) seenGap = true
          continue
        }
        if (ti === 0) {
          if (t > 0 && !seenGap) seenGap = true
          if (ch === tokens[t][0]) {
            if (t === 0) { startNode = stream[s].node; startOff = stream[s].offset }
            ti = 1
          } else {
            seenGap = true
            continue
          }
          if (tokens[t].length === 1) {
            endNode = stream[s].node
            endOff = stream[s].offset
            t++
            ti = 0
            seenGap = false
          }
          continue
        }
        if (ch === tokens[t][ti]) {
          ti++
          if (ti === tokens[t].length) {
            endNode = stream[s].node
            endOff = stream[s].offset
            t++
            ti = 0
            seenGap = false
          }
        } else {
          ti = 0
          if (ch === tokens[t][0]) {
            if (t === 0) { startNode = stream[s].node; startOff = stream[s].offset }
            ti = 1
            if (tokens[t].length === 1) {
              endNode = stream[s].node
              endOff = stream[s].offset
              t++
              ti = 0
              seenGap = false
            }
          }
        }
      }
      if (t === tokens.length && startNode !== null) {
        var range = document.createRange()
        range.setStart(startNode, startOff)
        range.setEnd(endNode, endOff + 1)
        return range
      }
      return null
    }

    /** 定位批注的 Range：消息 seq 锚定优先，空白不敏感重搜兜底。 */
    function locateQuote(quote, saved) {
      if (saved !== undefined && saved !== null && saved.range && saved.range.startContainer) {
        try {
          if (saved.range.startContainer.isConnected && saved.range.endContainer.isConnected) {
            var t = saved.range.toString()
            if (t.replace(/\s+/g, '') === quote.replace(/\s+/g, '')) {
              return saved.range
            }
          }
        } catch (_) { /* range 已失效 */ }
      }
      var rows = assistantRows()
      if (saved !== undefined && saved !== null && saved.seqKey !== '') {
        try {
          var item = document.querySelector('[data-chat-anchor-key="' + saved.seqKey + '"]')
          if (item !== null) {
            var itText = item.textContent || ''
            if (saved.textOffset >= 0) {
              var sp0 = findNormSpan(itText, quote)
              if (sp0 !== null && Math.abs(sp0.start - saved.textOffset) <= 2) {
                var itRange = rangeFromOffset(item, sp0.start, sp0.end - sp0.start)
                if (itRange !== null) return itRange
              }
            }
            if (saved.ctxBefore !== '') {
              var itIdx = itText.indexOf(saved.ctxBefore)
              if (itIdx !== -1) {
                var itNear = itIdx + saved.ctxBefore.length
                var sp1 = findNormSpan(itText.slice(itNear), quote)
                if (sp1 !== null) {
                  var itRange2 = rangeFromOffset(item, itNear + sp1.start, sp1.end - sp1.start)
                  if (itRange2 !== null) return itRange2
                }
              }
            }
            // 锚点消息内的全量扫描（空白不敏感 + 上下文评分）。
            var spansIt = allNormSpans(itText, quote)
            var bestIt = null
            var bestItScore = -1
            for (var pp2 = 0; pp2 < spansIt.length; pp2++) {
              var rngIt = rangeFromOffset(item, spansIt[pp2].start, spansIt[pp2].end - spansIt[pp2].start)
              if (rngIt === null) continue
              var scIt = ctxScore(itText, spansIt[pp2].start, spansIt[pp2].end - spansIt[pp2].start,
                { before: saved.ctxBefore || '', after: saved.ctxAfter || '' })
              if (scIt > bestItScore) { bestItScore = scIt; bestIt = rngIt }
            }
            if (bestIt !== null && (saved.ctxBefore === '' || bestItScore > 0)) return bestIt
            // 严格纪律：锚点消息还在但原文匹配不上 → 直接放弃（脚标隐藏），
            // 绝不跨消息模糊搜索——那是「跳到旧轮次」的根源。
            return null
          }
        } catch (_) { return null }
      }
      if (saved !== undefined && saved !== null && saved.rowHead !== '') {
        for (var r = 0; r < rows.length; r++) {
          var rowText = rows[r].textContent || ''
          if (rowText.slice(0, 24) !== saved.rowHead) continue
          if (saved.textOffset >= 0) {
            var spR = findNormSpan(rowText, quote)
            if (spR !== null && Math.abs(spR.start - saved.textOffset) <= 2) {
              var range = rangeFromOffset(rows[r], spR.start, spR.end - spR.start)
              if (range !== null) return range
            }
          }
          if (saved.ctxBefore !== '') {
            var bIdx = rowText.indexOf(saved.ctxBefore)
            if (bIdx !== -1) {
              var near = bIdx + saved.ctxBefore.length
              var spR2 = findNormSpan(rowText.slice(near), quote)
              if (spR2 !== null) {
                var range2 = rangeFromOffset(rows[r], near + spR2.start, spR2.end - spR2.start)
                if (range2 !== null) return range2
              }
            }
          }
          var spans = allNormSpans(rowText, quote)
          var bestRow = null
          var bestRowScore = -1
          for (var pp = 0; pp < spans.length; pp++) {
            var rng = rangeFromOffset(rows[r], spans[pp].start, spans[pp].end - spans[pp].start)
            if (rng === null) continue
            var sc = ctxScore(rowText, spans[pp].start, spans[pp].end - spans[pp].start,
              saved !== undefined && saved !== null
                ? { before: saved.ctxBefore || '', after: saved.ctxAfter || '' }
                : null)
            if (sc > bestRowScore) { bestRowScore = sc; bestRow = rng }
          }
          if (bestRow !== null) return bestRow
        }
      }
      var ctx = saved !== undefined && saved !== null
        ? { before: saved.ctxBefore || '', after: saved.ctxAfter || '' }
        : null
      var best = null
      var bestScore = -1
      for (var i = 0; i < rows.length; i++) {
        var full = rows[i].textContent || ''
        var spans = allNormSpans(full, quote)
        for (var p = 0; p < spans.length; p++) {
          var range = rangeFromOffset(rows[i], spans[p].start, spans[p].end - spans[p].start)
          if (range === null) continue
          var score = ctxScore(full, spans[p].start, spans[p].end - spans[p].start, ctx)
          if (score > bestScore) { bestScore = score; best = range }
        }
      }
      if (best !== null && (ctx === null || bestScore > 0)) return best
      var flow = document.querySelector('[data-chat-flow]')
      if (flow !== null) {
        var full2 = flow.textContent || ''
        var positions2 = allPositionsOf(flow, quote)
        var best2 = null
        var bestScore2 = -1
        for (var q2 = 0; q2 < positions2.length; q2++) {
          var range2 = rangeFromOffset(flow, positions2[q2], quote.length)
          if (range2 === null) continue
          var score2 = ctxScore(full2, positions2[q2], quote.length, ctx)
          if (score2 > bestScore2) { bestScore2 = score2; best2 = range2 }
        }
        if (best2 !== null && (ctx === null || bestScore2 > 0)) return best2
      }
      return null
    }

    function truncate(s, n) {
      return s.length > n ? s.slice(0, n) + '…' : s
    }

    function placeAbove(rect, height) {
      var w = 400
      var left = rect.left + rect.width / 2 - w / 2
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      var top = rect.top - height - 8
      if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - height - 8)
      return { left: Math.round(left), top: Math.round(Math.max(8, top)) }
    }

    function svg(paths, viewBox) {
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      s.setAttribute('viewBox', viewBox)
      s.setAttribute('fill', 'none')
      s.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      for (var i = 0; i < paths.length; i++) {
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        p.setAttribute('d', paths[i])
        p.setAttribute('fill', 'currentColor')
        s.appendChild(p)
      }
      return s
    }
    var ICONS = {
      plus: function () {
        return svg(['M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z'], '0 0 16 16')
      },
      check: function () {
        return svg([
          'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z',
        ], '0 0 16 16')
      },
      close: function () {
        return svg([
          'M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z',
          'M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z',
        ], '0 0 16 16')
      },
      send: function () {
        return svg([
          'M8.3125 0.981587C8.66767 1.0545 8.97902 1.20558 9.2627 1.43374C9.48724 1.61438 9.73029 1.85933 9.97949 2.10854L14.707 6.83608L13.293 8.25014L9 3.95717V15.0431H7V3.95717L2.70703 8.25014L1.29297 6.83608L6.02051 2.10854C6.26971 1.85933 6.51277 1.61438 6.7373 1.43374C6.97662 1.24126 7.28445 1.04542 7.6875 0.981587C7.8973 0.94841 8.1031 0.956564 8.3125 0.981587Z',
        ], '0 0 16 16')
      },
      trash: function () {
        return svg([
          'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z',
        ], '0 0 16 16')
      },
    }

    // ============================== 插件主体 ==============================
    function apply(ctx) {
      var sessions = ctx.sessions

      var host = document.createElement('div')
      host.setAttribute('data-annotation-for-dsh', '')
      document.body.appendChild(host)
      var overlay = document.createElement('div')
      overlay.setAttribute('data-annotation-overlay', '')
      document.body.appendChild(overlay)

      var ui = {
        mode: 'closed',      // closed | actions | editing | composing
        quote: '',
        quotes: [],          // [{ id, text, note, range, seqKey, rowHead, textOffset, ctxBefore, ctxAfter }]
        noteDraft: '',
        pos: { left: 0, top: 0 },
        error: null,
        busy: false,
        lastKey: '',
        pendingAnchor: null,
        el: null,
      }

      var ignoreUntil = 0
      var settleTimer = null

      // ---------- IME 合成 latch（对齐官方 InputBar composingRef）----------
      // macOS / 豆包等：compositionend 之后才会到 keydown(Enter, isComposing=false,
      // keyCode=13)，仅查 isComposing / 229 挡不住「上屏确认 Enter」。若此时
      // attachAndSend → setDraft，会打断合成，表现为只能打出拼音字母。
      // 延迟清 latch 与 InputBar 一致（略放宽到 50ms，兼容第三方输入法时序）。
      var imeComposing = false
      var imeClearTimer = null
      function markImeComposing() {
        imeComposing = true
        if (imeClearTimer !== null) {
          clearTimeout(imeClearTimer)
          imeClearTimer = null
        }
      }
      function markImeEnded() {
        if (imeClearTimer !== null) clearTimeout(imeClearTimer)
        imeClearTimer = setTimeout(function () {
          imeComposing = false
          imeClearTimer = null
        }, 50)
      }
      /** @param {KeyboardEvent} e */
      function isImeKeyBlocked(e) {
        return imeComposing || e.isComposing === true || e.keyCode === 229
      }
      document.addEventListener('compositionstart', markImeComposing, true)
      document.addEventListener('compositionend', markImeEnded, true)

      // ---------- 轻提示 ----------
      var toastTimer = null
      function showToast(msg) {
        try {
          var old = document.querySelector('[data-annotation-toast]')
          if (old !== null) old.remove()
          var el = document.createElement('div')
          el.setAttribute('data-annotation-toast', '')
          el.textContent = msg
          el.style.cssText = 'position:fixed;z-index:1300;left:50%;bottom:88px;transform:translateX(-50%);max-width:min(420px,calc(100vw - 24px));padding:8px 14px;border-radius:10px;background:var(--dsw-specific-menu,#2c2c2e);border:1px solid var(--dsw-alias-border-inverted);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,system-ui);font-size:12px;pointer-events:none;'
          document.body.appendChild(el)
          if (toastTimer !== null) clearTimeout(toastTimer)
          toastTimer = setTimeout(function () {
            toastTimer = null
            if (el.parentNode) el.parentNode.removeChild(el)
          }, 3000)
        } catch (_) { /* toast 失败忽略 */ }
      }

      // ---------- 选区监听 ----------
      function selectionKey(sel) {
        if (sel === null || sel.rangeCount === 0) return ''
        var r = sel.getRangeAt(0)
        return String(r.startContainer === r.endContainer ? 1 : 0)
          + ':' + r.startOffset + ':' + r.endOffset + ':' + sel.toString().length
      }

      function onSelection() {
        if (ui.mode !== 'closed' && host.childNodes.length === 0) {
          ui.mode = 'closed'
          ui.lastKey = ''
        }
        if (ui.mode === 'editing' || ui.mode === 'composing' || ignoreUntil > Date.now()) return
        var sel = window.getSelection()
        if (sel === null || sel.isCollapsed || sel.rangeCount === 0) {
          clearSettle()
          return
        }
        var range = sel.getRangeAt(0)
        var anc = range.commonAncestorContainer
        var ancEl = anc instanceof Element ? anc : (anc && anc.parentElement)
        if (ancEl !== null && ancEl.closest) {
          if (ancEl.closest('[data-annotation-for-dsh]') || ancEl.closest('[data-annotation-overlay]')
            || ancEl.closest('[data-composer-card]') || ancEl.closest('[data-input-scroll]')) {
            clearSettle()
            return
          }
        }
        if (host.contains(anc) || overlay.contains(anc)) {
          clearSettle()
          return
        }
        var text = sel.toString().trim()
        if (text.length === 0) { clearSettle(); return }
        var key = selectionKey(sel)
        if (ui.mode === 'actions' && key === ui.lastKey) { clearSettle(); return }
        var rootEl = assistantRowOf(range.commonAncestorContainer)
        if (rootEl === null) { clearSettle(); closeToolbar(); return }
        clearSettle()
        settleTimer = setTimeout(function () {
          settleTimer = null
          if (ui.mode === 'editing' || ui.mode === 'composing') return
          var s = window.getSelection()
          if (s === null || s.isCollapsed || selectionKey(s) !== key) return
          var r = s.getRangeAt(0)
          if (assistantRowOf(r.commonAncestorContainer) === null) return
          var rect = r.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return
          var p = placeAbove(rect, 40)
          if (ui.mode === 'actions' && ui.quote === text) {
            ui.lastKey = key
            ui.pos = p
            if (ui.el !== null && ui.el.style) {
              ui.el.style.left = p.left + 'px'
              ui.el.style.top = p.top + 'px'
            }
            return
          }
          ui.lastKey = key
          ui.mode = 'actions'
          ui.quote = text
          ui.error = null
          ui.pos = p
          render()
        }, 250)
      }
      document.addEventListener('selectionchange', onSelection)

      function clearSettle() {
        if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
      }

      function onHostPointerDown() { ignoreUntil = Date.now() + 80 }
      host.addEventListener('pointerdown', onHostPointerDown)

      function onDocPointerDown(e) {
        if (ui.mode === 'actions' && !host.contains(e.target) && !overlay.contains(e.target)) {
          closeToolbar()
        }
      }
      document.addEventListener('pointerdown', onDocPointerDown, true)

      var anchorRaf = false
      var lostSince = 0
      var ANCHOR_LOST_MS = 1000
      function onLayoutChange() {
        if (anchorRaf) return
        anchorRaf = true
        requestAnimationFrame(function () {
          anchorRaf = false
          if (ui.quotes.length > 0) renderMarkers()
          if (ui.mode !== 'actions' || ui.quote === '') return
          var rect = null
          var sel = window.getSelection()
          if (sel !== null && !sel.isCollapsed && sel.rangeCount > 0) {
            var live = sel.getRangeAt(0)
            if (assistantRowOf(live.commonAncestorContainer) !== null
              && sel.toString().trim() === ui.quote) {
              rect = live.getBoundingClientRect()
            }
          }
          if (rect === null) {
            var range = locateQuote(ui.quote)
            if (range !== null) rect = range.getBoundingClientRect()
          }
          if (rect === null || rect.width === 0 || rect.height === 0) {
            if (lostSince === 0) lostSince = Date.now()
            if (Date.now() - lostSince > ANCHOR_LOST_MS) { lostSince = 0; closeToolbar() }
            return
          }
          lostSince = 0
          var p = placeAbove(rect, 40)
          if (Math.abs(p.left - ui.pos.left) + Math.abs(p.top - ui.pos.top) > 2) {
            ui.pos = p
            if (ui.el !== null && ui.el.style) {
              ui.el.style.left = p.left + 'px'
              ui.el.style.top = p.top + 'px'
            } else {
              render()
            }
          }
        })
      }
      window.addEventListener('scroll', onLayoutChange, true)
      window.addEventListener('resize', onLayoutChange)

      function mutationRelevant(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var t = mutations[i].target
          var el = t instanceof Element ? t : (t && t.parentElement)
          if (el === null || !el.closest) return true
          if (el.closest('[data-composer-card]') || el.closest('[data-input-scroll]')
            || el.closest('[data-annotation-for-dsh]') || el.closest('[data-annotation-overlay]')) {
            continue
          }
          return true
        }
        return false
      }
      var observer = new MutationObserver(function (mutations) {
        if (!mutationRelevant(mutations)) return
        onLayoutChange()
        // 消息行插入/内容填充的瞬间同步执行气泡装饰（隐藏批注块 + 贴标签）：
        // MutationObserver 回调在微任务阶段运行，早于浏览器绘制，
        // 用户看不到「先显示批注块再隐藏」的闪烁。
        decorateAll()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          if (ui.mode !== 'closed') closeToolbar()
          return
        }
        // 【回车随输入框发送】在 composer 里按 Enter（且已收集批注、非输入法合成）：
        // 提交前一刻把批注块拼进草稿，composer 自己的 Enter 提交继续——模型收到
        // 批注清单 + 用户输入的问题。用户始终看不到文本被塞进去。
        // IME 铁律（v1.3.10 修了 nativeEvent.keyCode；v1.3.11 补 compositionend
        // 后 Enter keyCode=13 的时序洞）：合成期 / 上屏确认 Enter 绝不能 setDraft。
        if (e.key === 'Enter' && ui.quotes.length > 0 && !isImeKeyBlocked(e)) {
          var ta = e.target
          if (ta instanceof HTMLTextAreaElement && ta.closest && ta.closest('[data-composer-card]') !== null) {
            attachAndSend()
          }
        }
      }
      // capture 阶段：必须先于 composer 自己的 Enter 处理（React 在容器层冒泡
      // 提交）——否则等我们执行时消息已提交，拼稿永远太迟。
      document.addEventListener('keydown', onKeyDown, true)

      // ---------- 渲染 ----------
      function iconButton(cls, icon, title, onClick) {
        var b = document.createElement('button')
        b.type = 'button'
        b.className = cls
        b.title = title
        b.appendChild(icon())
        b.addEventListener('click', function () { ignoreUntil = Date.now() + 80; onClick() })
        return b
      }

      function ghostButton(icon, label, title, disabled, onClick) {
        var b = document.createElement('button')
        b.type = 'button'
        b.className = 'dsh-ann-ghost'
        b.title = title
        if (icon !== null) b.appendChild(icon())
        b.appendChild(document.createTextNode(label))
        b.disabled = disabled === true
        b.addEventListener('click', function () { ignoreUntil = Date.now() + 80; onClick() })
        return b
      }

      function render() {
        host.textContent = ''
        ui.el = null
        if (ui.mode === 'actions') {
          var bar = document.createElement('div')
          bar.className = 'dsh-ann-bar'
          bar.style.left = ui.pos.left + 'px'
          bar.style.top = ui.pos.top + 'px'
          var already = ui.quotes.some(function (q) { return q.text === ui.quote })
          bar.appendChild(ghostButton(
            already ? null : ICONS.plus,
            already ? '已批注' : '批注',
            already ? '这段内容已在批注清单中' : '为选中的内容写一条批注',
            already,
            enterEditing,
          ))
          bar.appendChild(iconButton('dsh-ann-icon', ICONS.close, '关闭', closeToolbar))
          host.appendChild(bar)
          ui.el = bar
        } else if (ui.mode === 'editing') {
          var card = document.createElement('div')
          card.className = 'dsh-ann-card'
          card.style.left = ui.pos.left + 'px'
          card.style.top = ui.pos.top + 'px'
          ui.el = card
          var head = document.createElement('div')
          head.className = 'dsh-ann-card-head'
          var title = document.createElement('div')
          title.className = 'dsh-ann-card-title'
          title.textContent = '添加批注'
          head.appendChild(title)
          head.appendChild(iconButton('dsh-ann-icon', ICONS.close, '取消', closeToolbar))
          card.appendChild(head)
          var quote = document.createElement('div')
          quote.className = 'dsh-ann-quote'
          quote.textContent = truncate(ui.quote, 200)
          quote.title = ui.quote
          card.appendChild(quote)
          var ta = document.createElement('textarea')
          ta.className = 'dsh-ann-input'
          ta.placeholder = '写下批注…（可留空，保存后仅标记原文）'
          ta.value = ui.noteDraft
          ta.spellcheck = false
          ta.addEventListener('input', function () { ui.noteDraft = ta.value })
          ta.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey && !isImeKeyBlocked(e)) { e.preventDefault(); saveAnnotation() }
          })
          card.appendChild(ta)
          var row = document.createElement('div')
          row.className = 'dsh-ann-row'
          var cancel = document.createElement('button')
          cancel.className = 'dsh-ann-cancel'
          cancel.type = 'button'
          cancel.textContent = '取消'
          cancel.addEventListener('click', closeToolbar)
          var save = document.createElement('button')
          save.type = 'button'
          save.className = 'dsh-ann-action'
          save.appendChild(ICONS.check())
          save.appendChild(document.createTextNode('保存批注'))
          save.addEventListener('click', saveAnnotation)
          row.appendChild(cancel)
          row.appendChild(save)
          card.appendChild(row)
          if (ui.error !== null) {
            var err = document.createElement('div')
            err.className = 'dsh-ann-error'
            err.textContent = ui.error
            card.appendChild(err)
          }
          host.appendChild(card)
          ta.focus()
          ta.setSelectionRange(ta.value.length, ta.value.length)
          requestAnimationFrame(function () {
            var h = card.offsetHeight
            var t = parseFloat(card.style.top)
            if (t + h > window.innerHeight - 8) {
              card.style.top = Math.max(8, window.innerHeight - h - 8) + 'px'
            }
          })
        }
      }

      // ---------- 批注标记 ----------
      var markersSig = null
      function markersSignature() {
        var parts = []
        for (var i = 0; i < ui.quotes.length; i++) {
          var q = ui.quotes[i]
          var range = locateQuote(q.text, q)
          if (range === null) { parts.push(q.id + ':gone'); continue }
          var rects = range.getClientRects()
          for (var c = 0; c < rects.length; c++) {
            var r = rects[c]
            if (r.width === 0 || r.height === 0) continue
            parts.push(q.id + ':' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height))
          }
          if (rects.length > 0) parts.push(q.id + ':chip')
        }
        return parts.join('|')
      }

      function renderMarkers() {
        var sig = markersSignature()
        if (sig !== markersSig) {
          markersSig = sig
          overlay.textContent = ''
          buildMarkers()
        }
      }

      function buildMarkers() {
        if (ui.quotes.length === 0) return
        var placed = []
        for (var i = 0; i < ui.quotes.length; i++) {
          var q = ui.quotes[i]
          var range = locateQuote(q.text, q)
          if (range === null) continue
          var rects = range.getClientRects()
          for (var c = 0; c < rects.length; c++) {
            var rect = rects[c]
            if (rect.width === 0 || rect.height === 0) continue
            var hl = document.createElement('div')
            hl.className = 'dsh-ann-hl'
            hl.style.left = rect.left + 'px'
            hl.style.top = rect.top + 'px'
            hl.style.width = rect.width + 'px'
            hl.style.height = rect.height + 'px'
            overlay.appendChild(hl)
          }
          var anchor = null
          for (var k = 0; k < rects.length; k++) {
            var r = rects[k]
            if (r.width === 0 || r.height === 0) continue
            if (r.top > -8 && r.top < window.innerHeight) { anchor = r; break }
          }
          if (anchor === null && rects.length > 0 && rects[0].width > 0) anchor = rects[0]
          if (anchor !== null) {
            var chip = document.createElement('div')
            chip.className = 'dsh-ann-num'
            chip.textContent = String(i + 1)
            var chipTop = anchor.top - 20
            if (chipTop < 4) chipTop = Math.min(anchor.top + 2, window.innerHeight - 22)
            if (chipTop < 4) chipTop = 4
            var chipLeft = Math.max(4, Math.min(anchor.left - 4, window.innerWidth - 24))
            var tries = 0
            while (tries < 12) {
              var clash = false
              for (var p = 0; p < placed.length; p++) {
                var bp = placed[p]
                if (Math.abs(bp.left - chipLeft) < 18 && Math.abs(bp.top - chipTop) < 18) {
                  clash = true
                  break
                }
              }
              if (!clash) break
              chipLeft += 18
              if (chipLeft > window.innerWidth - 24) { chipLeft = 4; chipTop += 18 }
              tries++
            }
            placed.push({ left: chipLeft, top: chipTop })
            chip.style.left = chipLeft + 'px'
            chip.style.top = chipTop + 'px'
            overlay.appendChild(chip)
          }
        }
      }

      // ---------- 动作 ----------
      function captureAnchor(text) {
        var anchor = {
          range: null, seqKey: '', rowHead: '', textOffset: -1,
          ctxBefore: '', ctxAfter: '',
        }
        try {
          var sel = window.getSelection()
          if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return anchor
          var live = sel.getRangeAt(0)
          var liveText = live.toString()
          if (liveText.trim() !== text && liveText.trim().replace(/\s+/g, ' ') !== text.replace(/\s+/g, ' ')) {
            return anchor
          }
          anchor.range = live.cloneRange()
          var node = live.commonAncestorContainer
          var el = node instanceof Element ? node : (node !== null ? node.parentElement : null)
          while (el !== null && el !== document.body && !el.hasAttribute('data-chat-anchor-key')) {
            el = el.parentElement
          }
          if (el !== null && el.hasAttribute('data-chat-anchor-key')) {
            anchor.seqKey = el.getAttribute('data-chat-anchor-key') || ''
            var itemText = el.textContent || ''
            var realOff = offsetOfRangeInRow(el, live)
            if (realOff >= 0) {
              anchor.textOffset = realOff
              anchor.ctxBefore = itemText.slice(Math.max(0, realOff - 24), realOff)
              anchor.ctxAfter = itemText.slice(realOff + text.length, realOff + text.length + 24)
            }
          }
          var row = assistantRowOf(live.commonAncestorContainer)
          if (row !== null) {
            anchor.rowHead = (row.textContent || '').slice(0, 24)
          }
        } catch (_) { /* 抓取失败则保持空锚 */ }
        return anchor
      }

      function enterEditing() {
        ui.mode = 'editing'
        ui.noteDraft = ''
        ui.error = null
        ui.pendingAnchor = captureAnchor(ui.quote)
        render()
      }

      /** 组装批注块（编号 + 原文 + 批注，结尾带唯一的「提问：」分隔标记——
       *  不用「问题：」是因为标题行「回答我的问题：」里也含它，气泡隐藏手术会误命中）。 */
      function buildBlock() {
        var parts = ui.quotes.map(function (q, i) {
          var s = (i + 1) + '. ' + q.text.replace(/\n/g, '\n   ')
          if (q.note !== undefined && q.note.trim() !== '') {
            s += '\n   批注：' + q.note.replace(/\n/g, '\n    ')
          }
          return s
        })
        return '我批注了以下 ' + ui.quotes.length + ' 处内容（编号与原文对应），请针对它们回答我的问题：\n\n'
          + parts.join('\n\n')
          + '\n\n请用「Annotation 1：…」到「Annotation ' + ui.quotes.length + '：…」的格式，逐条回应上面每一条批注，最后再回答我的问题。\n\n提问：'
      }

      /** 提交前把批注块拼进 composer 草稿（随回车一起发送）。 */
      function attachAndSend() {
        var current = sessions.list.getSnapshot().current
        if (current === undefined) return
        try {
          var scoped = sessions.scope(current)
          if (scoped === undefined) return
          var shell = ctx.conversation.input.for(scoped)
          var st = shell.state.getSnapshot()
          var draft = st.draft || ''
          // 草稿已含批注块（上次追加未发送）→ 不重复追加。
          if (draft.indexOf('我批注了以下') !== -1) return
          var block = buildBlock()
          shell.setDraft(block + '\n' + draft)
          console.log('[annotation] 批注块已拼入草稿，回车将随消息发送（' + ui.quotes.length + ' 条）')
        } catch (err) {
          console.warn('[annotation] 批注拼稿失败：', err)
          showToast('批注拼稿失败，消息将不带批注发送：' + (err && err.message ? err.message : err))
        }
      }

      function saveAnnotation() {
        var text = ui.quote
        if (text === '') { ui.error = '没有选中的内容'; render(); return }
        if (!ui.quotes.some(function (q) { return q.text === text })) {
          var a = ui.pendingAnchor || { range: null, seqKey: '', rowHead: '', textOffset: -1, ctxBefore: '', ctxAfter: '' }
          ui.quotes.push({
            id: 'q-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            text: text,
            note: ui.noteDraft.trim(),
            range: a.range,
            seqKey: a.seqKey,
            rowHead: a.rowHead,
            textOffset: a.textOffset,
            ctxBefore: a.ctxBefore,
            ctxAfter: a.ctxAfter,
          })
        }
        ui.pendingAnchor = null
        ui.noteDraft = ''
        ui.error = null
        closeToolbar()
        updateChip()
        renderMarkers()
      }

      function removeQuote(id) {
        ui.quotes = ui.quotes.filter(function (q) { return q.id !== id })
        updateChip()
        render()
        renderMarkers()
        // 面板正在显示时同步重建：否则删掉的条目还留在面板里，必须重新 hover 才消失。
        if (tipLayer.childNodes.length > 0) showChipTip()
      }

      function closeToolbar() {
        if (ui.mode === 'closed') return
        clearSettle()
        ui.mode = 'closed'
        ui.error = null
        ui.busy = false
        ui.lastKey = ''
        render()
      }

      // ---------- 输入框旁的批注标签（N 条批注 · 悬浮看全部内容） ----------
      var chipLayer = document.createElement('div')
      chipLayer.setAttribute('data-annotation-chip', '')
      chipLayer.style.cssText = 'position:fixed;z-index:1150;display:none;align-items:center;gap:4px;height:22px;padding:0 10px;border-radius:11px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,#2c2c2e);box-shadow:var(--dsw-shadow-lv3);font-family:var(--dsw-font-family,system-ui);font-size:11px;color:var(--dsw-alias-label-primary);cursor:default;'
      document.body.appendChild(chipLayer)
      var tipLayer = document.createElement('div')
      tipLayer.setAttribute('data-annotation-tip-layer', '')
      document.body.appendChild(tipLayer)

      function updateChip() {
        if (ui.quotes.length === 0) {
          chipLayer.style.display = 'none'
          tipLayer.textContent = ''
          return
        }
        chipLayer.textContent = ''
        var b = document.createElement('b')
        b.style.cssText = 'color:var(--dsw-alias-text-accent,#4c9aff);font-weight:700;'
        b.textContent = String(ui.quotes.length)
        chipLayer.appendChild(b)
        chipLayer.appendChild(document.createTextNode('条批注'))
        var card = document.querySelector('[data-composer-card]')
        if (card === null) { chipLayer.style.display = 'none'; return }
        var r = card.getBoundingClientRect()
        var w = chipLayer.offsetWidth || 80
        chipLayer.style.left = Math.max(8, r.right - w - 12) + 'px'
        chipLayer.style.top = Math.max(8, r.top - 30) + 'px'
        chipLayer.style.display = 'flex'
      }

      // 悬停宽限：标签与面板间有间隙，鼠标跨越间隙的瞬间不在任何元素上——
      // 离开后给 250ms 宽限期，期间进入面板则取消关闭（官方 HoverCard 的
      // pointer-grace 同款思路），同时杜绝闪烁循环。
      var hoverGrace = null
      function scheduleHide() {
        if (hoverGrace !== null) clearTimeout(hoverGrace)
        hoverGrace = setTimeout(function () {
          hoverGrace = null
          tipLayer.textContent = ''
        }, 250)
      }
      function cancelHide() {
        if (hoverGrace !== null) { clearTimeout(hoverGrace); hoverGrace = null }
      }
      chipLayer.addEventListener('mouseenter', function () { cancelHide(); showChipTip() })
      chipLayer.addEventListener('mouseleave', scheduleHide)
      tipLayer.addEventListener('mouseenter', cancelHide)
      tipLayer.addEventListener('mouseleave', scheduleHide)

      function showChipTip() {
        if (ui.quotes.length === 0) return
        tipLayer.textContent = ''
        var el = document.createElement('div')
        el.className = 'dsh-ann-tip'
        el.style.cssText = 'position:fixed;z-index:1160;width:300px;max-width:calc(100vw - 16px);padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,#2c2c2e);box-shadow:var(--dsw-shadow-lv3);font-family:var(--dsw-font-family,system-ui);font-size:12px;color:var(--dsw-alias-label-primary);'
        var head = document.createElement('div')
        head.style.cssText = 'font-weight:600;margin-bottom:6px;'
        head.textContent = '批注（' + ui.quotes.length + ' 条）'
        el.appendChild(head)
        for (var i = 0; i < ui.quotes.length; i++) {
          var q = ui.quotes[i]
          var item = document.createElement('div')
          item.style.cssText = 'padding:6px 0;border-top:1px solid var(--dsw-alias-border-strong,#444);'
          var num = document.createElement('span')
          num.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;margin-right:6px;border-radius:8px;background:var(--dsw-alias-text-accent,#4c9aff);color:#fff;font-size:10px;font-weight:700;'
          num.textContent = String(i + 1)
          var body = document.createElement('span')
          body.style.cssText = 'font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);'
          body.textContent = truncate(q.text, 50)
          item.appendChild(num)
          item.appendChild(body)
          if (q.note !== undefined && q.note.trim() !== '') {
            var note = document.createElement('div')
            note.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary);margin:2px 0 0 22px;word-break:break-word;'
            note.textContent = '批注：' + truncate(q.note, 60)
            item.appendChild(note)
          }
          var del = document.createElement('button')
          del.type = 'button'
          del.textContent = '删'
          del.style.cssText = 'margin-left:8px;background:transparent;border:1px solid rgba(255,107,107,.4);color:#ff8a8a;border-radius:6px;font-size:10px;cursor:pointer;padding:1px 6px;'
          ;(function (qid) {
            del.addEventListener('click', function (ev) {
              ev.stopPropagation()
              removeQuote(qid)
            })
          })(q.id)
          item.appendChild(del)
          el.appendChild(item)
        }
        tipLayer.appendChild(el)
        var r2 = chipLayer.getBoundingClientRect()
        var w2 = 300
        var h2 = el.offsetHeight || 120
        var left = Math.max(8, Math.min(r2.left, window.innerWidth - w2 - 8))
        var top = r2.top - h2 - 6
        if (top < 8) top = r2.bottom + 6
        el.style.left = left + 'px'
        el.style.top = Math.max(8, top) + 'px'
        el.style.width = w2 + 'px'
      }

      // ---------- 发送完成监听（草稿从有内容变空 → 清空批注集） ----------
      var inputUnsub = null
      function watchInputDraft() {
        if (typeof inputUnsub === 'function') { inputUnsub(); inputUnsub = null }
        var id = sessions.list.getSnapshot().current
        if (id === undefined) return
        try {
          var sc = sessions.scope(id)
          if (sc === undefined) return
          var sh = ctx.conversation.input.for(sc)
          var hadDraft = false
          inputUnsub = sh.state.subscribe(function () {
            var d = (sh.state.getSnapshot().draft || '').trim()
            var wasHad = hadDraft
            hadDraft = d !== ''
            if (ui.quotes.length === 0) return
            // 发送完成：草稿从有内容变空 → 脚标消失、编号下次从 1 开始；
            // 同时在刚发出的用户消息气泡上贴「N 条批注」标签。
            if (wasHad && d === '') {
              var sentItems = ui.quotes.map(function (q) {
                return { text: q.text, note: q.note || '' }
              })
              ui.quotes = []
              tipLayer.textContent = ''
              updateChip()
              renderMarkers()
              pendingDeco.push({ items: sentItems })
              kickDecorate()
            }
          })
        } catch (_) { inputUnsub = null }
      }

      /** 把批注块文本从用户消息气泡里藏掉（模型消息内容不受影响）：
       *  用户气泡是纯文本渲染（MessageText，单个文本节点），
       *  找到最后一个「\n提问：」（老格式回退「\n问题：」），
       *  保留其后的用户问题，整块批注文本从 DOM 移除。
       *  返回是否成功（内容未渲染完时返回 false，轮询稍后重试）。 */
      function hideAnnotationBlock(row) {
        try {
          var bubble = row.querySelector('[class*="bubble"]')
          if (bubble === null) return false
          var nodes = []
          var full = ''
          var walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT)
          var n
          while ((n = walker.nextNode()) !== null) {
            nodes.push(n)
            full += n.nodeValue || ''
          }
          // 标记定位：优先「\n提问：」→「\n问题：」→ 裸「提问：」→ 裸「问题：」。
          var marker = -1
          var pairs = [['\n提问：', '\n问题：'], ['提问：', '问题：']]
          for (var p = 0; p < pairs.length && marker === -1; p++) {
            for (var k = 0; k < 2; k++) {
              var idx = full.lastIndexOf(pairs[p][k])
              if (idx !== -1) { marker = idx; break }
            }
          }
          if (marker === -1) return false
          // 标记若带「\n」前缀（段落起头），切掉长度 4（\n提问：），否则 3（提问：）。
          var skip = full.charAt(marker) === '\n' ? 4 : 3
          // 定位到具体文本节点。
          var pos = 0
          var ti = -1
          var inner = 0
          for (var j = 0; j < nodes.length; j++) {
            var len = (nodes[j].nodeValue || '').length
            if (marker < pos + len) { ti = j; inner = marker - pos; break }
            pos += len
          }
          if (ti === -1) return false
          // 去掉标记及其前的所有内容，保留其后的问题。
          nodes[ti].nodeValue = (nodes[ti].nodeValue || '').slice(inner + skip).replace(/^\s+/, '')
          for (var m2 = ti - 1; m2 >= 0; m2--) {
            if (nodes[m2].parentNode !== null) nodes[m2].parentNode.removeChild(nodes[m2])
          }
          // 清理空元素。
          var empties = bubble.querySelectorAll('div,span,p')
          for (var e = 0; e < empties.length; e++) {
            var em = empties[e]
            if (em.parentNode !== null && (em.textContent || '').trim() === '') em.remove()
          }
          return true
        } catch (err) {
          console.warn('[annotation] 气泡隐藏手术失败：', err)
          return false
        }
      }

      /** 从气泡文本反解析批注条目（用于刷新后旧消息的 hover 内容）。 */
      function parseItemsFromBubble(row) {
        try {
          var b = row.querySelector('[class*="bubble"]')
          var text = (b ? b.textContent : '') || ''
          var mi = text.lastIndexOf('\n\n提问：')
          if (mi === -1) mi = text.lastIndexOf('\n\n问题：')
          if (mi !== -1) text = text.slice(0, mi)
          var nl = text.indexOf('\n\n')
          var body = nl === -1 ? '' : text.slice(nl + 2)
          var out = []
          var parts = body.split('\n\n')
          for (var i = 0; i < parts.length; i++) {
            var mm = /^(\d+)\.\s*([\s\S]*)$/.exec(parts[i])
            if (mm === null) continue
            var item = mm[2]
            var note = ''
            var nm = /\n   批注：([\s\S]*)$/.exec(item)
            if (nm !== null) { note = nm[1].trim(); item = item.slice(0, nm.index) }
            out.push({ text: item.replace(/\n   /g, '\n').trim(), note: note })
          }
          return out
        } catch (_) { return [] }
      }

      /** 在用户气泡上贴「批注 ×N」标签（hover 显示条目内容）。 */
      function attachBubbleTag(row, items) {
        if (row.querySelector('[data-annotation-bubble-tag]') !== null) return
        var bubble = row.querySelector('[class*="bubble"]') || row
        var tag = document.createElement('span')
        tag.setAttribute('data-annotation-bubble-tag', '')
        tag.textContent = '批注 ×' + items.length
        tag.style.cssText = 'display:inline-flex;align-items:center;height:18px;padding:0 8px;margin:4px 0 0 4px;border-radius:9px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,#2c2c2e);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family,system-ui);font-size:10px;cursor:default;'
        ;(function (list) {
          tag.addEventListener('mouseenter', function () {
            tipLayer.textContent = ''
            var el = document.createElement('div')
            el.style.cssText = 'position:fixed;z-index:1160;width:300px;max-width:calc(100vw - 16px);padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,#2c2c2e);box-shadow:var(--dsw-shadow-lv3);font-family:var(--dsw-font-family,system-ui);font-size:12px;color:var(--dsw-alias-label-primary);'
            var head = document.createElement('div')
            head.style.cssText = 'font-weight:600;margin-bottom:6px;'
            head.textContent = '本消息携带批注（' + list.length + ' 条）'
            el.appendChild(head)
            for (var i = 0; i < list.length; i++) {
              var item = document.createElement('div')
              item.style.cssText = 'padding:6px 0;border-top:1px solid var(--dsw-alias-border-strong,#444);'
              var num = document.createElement('span')
              num.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;margin-right:6px;border-radius:8px;background:var(--dsw-alias-text-accent,#4c9aff);color:#fff;font-size:10px;font-weight:700;'
              num.textContent = String(i + 1)
              var body = document.createElement('span')
              body.style.cssText = 'font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);'
              body.textContent = truncate(list[i].text, 50)
              item.appendChild(num)
              item.appendChild(body)
              if (list[i].note !== '') {
                var note = document.createElement('div')
                note.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary);margin:2px 0 0 22px;word-break:break-word;'
                note.textContent = '批注：' + truncate(list[i].note, 60)
                item.appendChild(note)
              }
              el.appendChild(item)
            }
            tipLayer.appendChild(el)
            var r2 = tag.getBoundingClientRect()
            var w2 = 300
            var h2 = el.offsetHeight || 120
            var left = Math.max(8, Math.min(r2.left, window.innerWidth - w2 - 8))
            var top = r2.bottom + 6
            if (top + h2 > window.innerHeight - 8) top = r2.top - h2 - 6
            el.style.left = left + 'px'
            el.style.top = Math.max(8, top) + 'px'
            el.style.width = w2 + 'px'
          })
          var bubbleGrace = null
          function bubbleHide() {
            if (bubbleGrace !== null) clearTimeout(bubbleGrace)
            bubbleGrace = setTimeout(function () {
              bubbleGrace = null
              tipLayer.textContent = ''
            }, 250)
          }
          function bubbleKeep() {
            if (bubbleGrace !== null) { clearTimeout(bubbleGrace); bubbleGrace = null }
          }
          tag.addEventListener('mouseleave', bubbleHide)
          tipLayer.addEventListener('mouseenter', bubbleKeep)
          tipLayer.addEventListener('mouseleave', bubbleHide)
        })(items)
        tag.__annotationItems = items
        bubble.appendChild(tag)
        console.log('[annotation] 气泡已贴批注标签 ×' + items.length)
      }

      /** 发送完成时暂存批注数据（供气泡 hover 面板使用）。 */
      var pendingDeco = []

      // ---------- 助手回复中的「Annotation N：」→ 悬浮批注芯片 ----------

      /** 找到该回复行之前最近一条携带批注标签的用户消息的条目数据。 */
      function findPrevAnnotationItems(row) {
        var rows = allMessageRows()
        var idx = rows.indexOf(row)
        if (idx === -1) return null
        for (var i = idx - 1; i >= 0; i--) {
          var tag = rows[i].querySelector('[data-annotation-bubble-tag]')
          if (tag !== null && Array.isArray(tag.__annotationItems) && tag.__annotationItems.length > 0) {
            return tag.__annotationItems
          }
        }
        return null
      }

      /** 一次性诊断（仅控制台，不打扰用户）：标记行 + 原因。 */
      function markRowDiag(row, msg) {
        if (row.hasAttribute('data-annotation-diag')) return
        row.setAttribute('data-annotation-diag', '')
        console.warn('[annotation] ' + msg, row)
      }

      /** 扫描所有已结束流式输出的助手行：把「Annotation N：」替换为可悬浮芯片。 */
      function decorateAssistantAnnotations() {
        var rows = assistantRows()
        for (var i = 0; i < rows.length; i++) {
          var el = rows[i]
          if (!isAssistantRow(el)) continue
          // 新版 data-streaming 标记在 AssistantMarkdown 内部元素上（行元素
          // 本身没有）——必须查行内，否则流式输出途中就把「Annotation N：」
          // 替换成芯片，与 React 正在更新的文本节点冲突，整条回复可能渲染
          // 异常（表现为看不到回复消息）。
          if (el.hasAttribute('data-streaming') || el.querySelector('[data-streaming]') !== null) continue
          if (el.querySelector('[data-annotation-reply-chip]') !== null) continue
          if ((el.textContent || '').indexOf('Annotation') === -1) continue
          var items = findPrevAnnotationItems(el)
          if (items === null || items.length === 0) {
            // 拿不到条目数据也照样生成芯片（hover 显示占位），并一次性提示。
            items = []
            markRowDiag(el, '未找到批注条目数据，芯片将显示占位内容（可继续用）')
          }
          decorateAnnotationLabels(el, items)
        }
      }

      /** 在行内所有文本节点中找「Annotation N：」（不区分大小写），替换为芯片。 */
      function decorateAnnotationLabels(row, items) {
        var re = /Annotation[\s\u200b\u200c\u200d\u00ad]*(\d+)[\s\u200b\u200c\u200d\u00ad]*[:：]/gi
        // 先快照所有文本节点，再逐个处理：遍历中途修改树会让 TreeWalker
        // 指针失效（处理完第一个节点后遍历就断了）——这是「只有第一个
        // Annotation 变成芯片」的根因。
        var nodes = []
        var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        var n
        while ((n = walker.nextNode()) !== null) nodes.push(n)
        var done = 0
        for (var i = 0; i < nodes.length; i++) {
          n = nodes[i]
          if (n.parentNode === null) continue
          var v = n.nodeValue || ''
          re.lastIndex = 0
          if (!re.test(v)) continue
          var frag = document.createDocumentFragment()
          var last = 0
          re.lastIndex = 0
          var m
          while ((m = re.exec(v)) !== null) {
            if (m.index > last) frag.appendChild(document.createTextNode(v.slice(last, m.index)))
            frag.appendChild(makeReplyChip(parseInt(m[1], 10), items))
            last = m.index + m[0].length
            done++
          }
          if (last < v.length) frag.appendChild(document.createTextNode(v.slice(last)))
          n.parentNode.replaceChild(frag, n)
        }
        if (done > 0) {
          console.log('[annotation] 回复批注芯片 ×' + done, row.querySelectorAll('[data-annotation-reply-chip]').length + ' 个元素')
        } else {
          // 行内含 Annotation 但一个都没匹配上 → 文本节点里没有完整「Annotation N：」模式
          markRowDiag(row, '行内含 Annotation 但未匹配到「Annotation N：」模式')
        }
      }

      /** 构造「Annotation N」芯片（hover 显示该批注的原文与批注内容）。 */
      function makeReplyChip(num, items) {
        var chip = document.createElement('span')
        chip.setAttribute('data-annotation-reply-chip', '')
        chip.style.cssText = 'display:inline-flex;align-items:center;height:18px;padding:0 6px;margin:0 2px;border-radius:9px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,#2c2c2e);color:var(--dsw-alias-text-accent,#4c9aff);font-family:var(--dsw-font-family,system-ui);font-size:11px;font-weight:600;cursor:default;vertical-align:middle;'
        chip.textContent = 'Annotation ' + num
        var item = items[num - 1]
        var grace = null
        function hide() {
          if (grace !== null) clearTimeout(grace)
          grace = setTimeout(function () { grace = null; tipLayer.textContent = '' }, 250)
        }
        function keep() {
          if (grace !== null) { clearTimeout(grace); grace = null }
        }
        chip.addEventListener('mouseenter', function () {
          tipLayer.textContent = ''
          var el = document.createElement('div')
          el.style.cssText = 'position:fixed;z-index:1160;width:320px;max-width:calc(100vw - 16px);padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,#2c2c2e);box-shadow:var(--dsw-shadow-lv3);font-family:var(--dsw-font-family,system-ui);font-size:12px;color:var(--dsw-alias-label-primary);'
          var head = document.createElement('div')
          head.style.cssText = 'font-weight:600;margin-bottom:6px;'
          head.textContent = item !== undefined ? '批注 ' + num + ' 的原文' : '批注 ' + num
          el.appendChild(head)
          if (item !== undefined) {
            var quote = document.createElement('div')
            quote.style.cssText = 'font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-word;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.12);'
            quote.textContent = truncate(item.text, 140)
            el.appendChild(quote)
            if (item.note !== '') {
              var note = document.createElement('div')
              note.style.cssText = 'font-size:11px;color:var(--dsw-alias-text-accent,#4c9aff);margin-top:6px;word-break:break-word;'
              note.textContent = '你的批注：' + truncate(item.note, 80)
              el.appendChild(note)
            }
          } else {
            var none = document.createElement('div')
            none.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary);'
            none.textContent = '（未找到对应批注条目）'
            el.appendChild(none)
          }
          tipLayer.appendChild(el)
          var r2 = chip.getBoundingClientRect()
          var w2 = 320
          var h2 = el.offsetHeight || 100
          var left = Math.max(8, Math.min(r2.left, window.innerWidth - w2 - 8))
          var top = r2.bottom + 6
          if (top + h2 > window.innerHeight - 8) top = r2.top - h2 - 6
          el.style.left = left + 'px'
          el.style.top = Math.max(8, top) + 'px'
          el.style.width = w2 + 'px'
        })
        chip.addEventListener('mouseleave', hide)
        tipLayer.addEventListener('mouseenter', keep)
        tipLayer.addEventListener('mouseleave', hide)
        return chip
      }

      /** 全局轮询装饰：找所有「携带批注块但未装饰」的用户气泡 → 隐藏批注块 + 贴标签。
       *  不依赖发送事件链：异步渲染、刷新后的历史消息都能被覆盖。 */
      function decorateAll() {
        try {
          var rows = allMessageRows()
          for (var i = rows.length - 1; i >= 0; i--) {
            var el = rows[i]
            if (el.hasAttribute('data-pending-steering')) continue
            if (el.querySelector('[data-annotation-bubble-tag]') !== null) continue
            var b = el.querySelector('[class*="bubble"]')
            if (b === null || (b.textContent || '').indexOf('我批注了以下') === -1) continue
            // 最新一条优先消费发送时暂存的数据；其余从气泡文本反解析（须在隐藏前）。
            var items = null
            if (i === rows.length - 1 && pendingDeco.length > 0) items = pendingDeco.pop().items
            if (items === null || items.length === 0) items = parseItemsFromBubble(el)
            if (!hideAnnotationBlock(el)) continue // 内容未渲染完 → 留给下轮
            attachBubbleTag(el, items)
            // 批注已随消息真实发出（用户气泡带着批注块出现）→ 清空待发送批注集。
            // 兜底 watchInputDraft 在初始化时会话未加载时失效的场景：若不清空，
            // 之后每次在 composer 按 Enter 都会把批注块重新注入草稿，且 setDraft
            // 可能打断输入法合成（中文上不了屏）。
            if (ui.quotes.length > 0) {
              ui.quotes = []
              updateChip()
              renderMarkers()
            }
          }
          // 助手回复：把「Annotation N：」变为可悬浮的批注芯片（内容取自最近一条带批注的用户消息）。
          decorateAssistantAnnotations()
        } catch (err) {
          console.warn('[annotation] 装饰扫描失败：', err)
        }
      }

      var decoTimer = null
      function kickDecorate() {
        decorateAll()
        if (decoTimer === null) decoTimer = setInterval(decorateAll, 1000)
      }

      // ---------- 会话切换时收起浮窗并清空批注 ----------
      var lastSessionId = sessions.list.getSnapshot().current
      var unsub = sessions.list.subscribe(function () {
        var cur = sessions.list.getSnapshot().current
        if (cur === lastSessionId) return
        lastSessionId = cur
        if (ui.mode !== 'closed') closeToolbar()
        ui.quotes = []
        ui.noteDraft = ''
        tipLayer.textContent = ''
        updateChip()
        watchInputDraft()
        renderMarkers()
      })

      watchInputDraft()
      kickDecorate()
      updateChip()

      // ---------- 清理 ----------
      return function () {
        clearSettle()
        document.removeEventListener('selectionchange', onSelection)
        document.removeEventListener('pointerdown', onDocPointerDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('compositionstart', markImeComposing, true)
        document.removeEventListener('compositionend', markImeEnded, true)
        if (imeClearTimer !== null) { clearTimeout(imeClearTimer); imeClearTimer = null }
        window.removeEventListener('scroll', onLayoutChange, true)
        window.removeEventListener('resize', onLayoutChange)
        host.removeEventListener('pointerdown', onHostPointerDown)
        observer.disconnect()
        if (typeof unsub === 'function') unsub()
        if (typeof inputUnsub === 'function') inputUnsub()
        if (decoTimer !== null) { clearInterval(decoTimer); decoTimer = null }
        chipLayer.remove()
        tipLayer.remove()
        host.remove()
        overlay.remove()
      }
    }

    exports.name = '@dsh-external/dsh-annotation'
    exports.inject = ['sessions', 'conversation']
    exports.apply = apply

    return module.exports
  },
})
