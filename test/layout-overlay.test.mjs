import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('设置弹窗打开时隐藏会话高亮层与编号层（issue #44）', () => {
  assert.match(source, /body:has\(\[role="dialog"\]\[aria-modal="true"\]\) \[data-annotation-overlay\],/)
  assert.match(source, /body:has\(\[role="dialog"\]\[aria-modal="true"\]\) \[data-annotation-num-layer\] \{ display: none; \}/)
})

test('编号独立成层：层级固定，且不压在输入框/会话头部上', () => {
  assert.match(source, /data-annotation-num-layer/, '编号应有自己的容器')
  const layer = source.slice(source.indexOf('var numLayer = document.createElement'), source.indexOf('var ui = {'))
  assert.match(layer, /z-index:1100/, '编号层使用统一层级（不跟随标记层的 900）')
  assert.match(layer, /pointer-events:none/, '编号层本体不吃事件')
  const render = source.slice(source.indexOf('function renderMarkers()'), source.indexOf('function buildMarkers()'))
  assert.match(render, /numLayer\.style\.clipPath = overlay\.style\.clipPath/, '编号层共用裁剪路径兜底，编号不会压在宿主 UI 上')
  const build = source.slice(source.indexOf('function buildMarkers()'), source.indexOf('// ---------- 动作 ----------'))
  assert.match(build, /numLayer\.appendChild\(chip\)/, '编号挂到编号层而不是被裁剪的高亮层')
  assert.doesNotMatch(build, /overlay\.appendChild\(chip\)/, '编号不再挂进被裁剪的 overlay')
  assert.match(build, /hostComposerRects\(\)/, '编号的可见性判定覆盖整块输入区')
  const sig = source.slice(source.indexOf('function markersSignature('), source.indexOf('function hostLocalRects('))
  assert.match(sig, /blockers/, '遮挡区进入签名：输入框/头部变化时编号重走可见性判定')
})

test('滚动和布局变化会刷新输入框批注胶囊（issue #44）', () => {
  const start = source.indexOf('function onLayoutChange()')
  const end = source.indexOf("window.addEventListener('scroll', onLayoutChange, true)", start)
  assert.ok(start >= 0 && end > start, 'client.js should define the shared layout refresh')
  assert.match(source.slice(start, end), /updateChip\(\)/)
  assert.match(source, /new ResizeObserver\(onLayoutChange\)/)
  assert.match(source, /composerObserver\.disconnect\(\)/)
})

test('工具条优先选区下方，底部空间不足时放在上方（PR #48）', () => {
  const match = source.match(/function placeAbove\(rect, height\) \{[\s\S]*?\n    \}/)
  assert.ok(match)
  const place = Function('window', `return (${match[0]})`)({ innerWidth: 1000, innerHeight: 800 })
  assert.equal(place({ left: 200, width: 300, top: 300, bottom: 320 }, 40).top, 328)
  assert.equal(place({ left: 200, width: 300, top: 750, bottom: 770 }, 40).top, 702)
  assert.ok(place({ left: -100, width: 300, top: 0, bottom: 800 }, 40).top >= 8)
})

test('共享悬浮面板按归属清理：宿主 layout mutation 不误杀正在观看的面板', () => {
  // 归属机制存在：清空必须指名归属元素。
  assert.match(source, /var tipOwner = null/)
  assert.match(source, /function clearTip\(owner\) \{\r?\n\s+if \(owner !== undefined && tipOwner !== owner\) return/)
  assert.match(source, /function presentTip\(owner, el\) \{[\s\S]*?tipOwner = owner/)

  // 唯一的裸清空只允许在 clearTip / presentTip 内部，其它调用点一律走归属 API。
  const raw = source.match(/tipLayer\.textContent = ''/g) ?? []
  assert.equal(raw.length, 2, 'tipLayer 只能被 clearTip/presentTip 独占清空')

  // updateChip 的「无待发送批注」分支：只能清胶囊自己的面板。该分支由 body 上
  // MutationObserver（attributes/characterData/childList）经 onLayoutChange 高频
  // 触发，无归属清空会把 hover 中的气泡标签/回复芯片面板抹掉。
  const start = source.indexOf('function updateChip()')
  const end = source.indexOf('// 悬停宽限', start)
  assert.ok(start >= 0 && end > start, 'client.js 应定义 updateChip 与悬停宽限段')
  const updateChip = source.slice(start, end)
  assert.match(updateChip, /clearTip\(chipLayer\)/)
  assert.doesNotMatch(updateChip, /tipLayer\.textContent = ''/)

  // 三类面板（输入框胶囊 / 气泡标签 / 回复芯片）各自带归属挂载与清理。
  assert.match(source, /presentTip\(chipLayer, el\)/)
  assert.match(source, /clearTip\(chipLayer\)/)
  assert.match(source, /presentTip\(tag, el\)/)
  assert.match(source, /clearTip\(tag\)/)
  assert.match(source, /presentTip\(chip, el\)/)
  assert.match(source, /clearTip\(chip\)/)

  // 删除待发送批注时只重建胶囊面板，不接管他人的面板。
  assert.match(source, /if \(tipOwner === chipLayer\) showChipTip\(\)/)
})

test('标记层裁掉会话头部与输入区：编号与高亮像内容一样被遮住', () => {
  assert.match(source, /function hostLocalRects\(local\)/, '按 CSS Modules local 名统一取宿主矩形')
  assert.match(source, /function hostHeaderRects\(\)/, 'client.js 应定位宿主的会话头部')
  assert.match(source, /function hostComposerRects\(\)/, 'client.js 应定位整块输入区（含卡片下方统计行）')
  assert.match(source, /hostLocalRects\('composerSeat'\)/, '输入区认 composerSeat，而不是单个输入卡片')
  const render = source.slice(source.indexOf('function renderMarkers()'), source.indexOf('function buildMarkers()'))
  assert.ok(render.length > 0, 'client.js 应定义 renderMarkers')
  assert.match(render, /hostComposerRects\(\)\.concat\(hostHeaderRects\(\)\)/, '输入区与头部共用挖空列表')
  assert.match(render, /clipWithHoles\(holes\)/, '共用同一条 evenodd 裁剪路径')

  // 编号只出现在"正文实际可见"的地方：与遮挡区或滚动容器边界冲突就不渲染。
  const build = source.slice(source.indexOf('function buildMarkers()'), source.indexOf('// ---------- 动作 ----------'))
  assert.ok(build.length > 0, 'client.js 应定义 buildMarkers')
  assert.match(build, /skipChip/, '不在可见区内的编号不渲染')
  assert.match(build, /hostLocalRects\('scrollBody'\)/, '编号必须落在正文滚动容器内')
  assert.match(build, /hostHeaderRects\(\)\.concat\(hostComposerRects\(\)\)/, '编号不得与会话头部或输入区相交')
  assert.doesNotMatch(build, /chipTop = hd\.bottom \+ 4/, '不再贴边钉住编号（滚出可视区就隐藏）')
})

test('编辑窗口：标题右侧可删除该批注，且不再有取消按钮', () => {
  const start = source.indexOf("} else if (ui.mode === 'editing') {")
  const end = source.indexOf('function positionEditor(card, left, top)', start)
  assert.ok(start >= 0 && end > start, 'client.js 应定义编辑卡片分支')
  const editor = source.slice(start, end)
  assert.match(editor, /dsh-ann-card-headmain/, '标题与其右侧按钮成组')
  assert.match(editor, /t\('edit\.delete'\)/, '删除按钮使用 i18n 文案')
  assert.match(editor, /removeQuote\(editingId\)/, '删除复用待发送批注移除逻辑')
  assert.doesNotMatch(editor, /dsh-ann-cancel/, '编辑窗口不再有取消按钮')
  assert.doesNotMatch(source, /dsh-ann-cancel/, '取消按钮的样式一并移除')
})

// Source slice for one `function name(...) { ... }` by brace matching.
function tryExtractFunction (name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return null
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

// [data-conversation-scroll] carries the conversation column: the session
// header sits above its top edge. The header hole must be bounded to that
// column, never the full viewport width — the sidebar file previews of #57
// live outside the conversation column and must stay paintable (#63).
const VIEW = { left: 12, top: 76, right: 912, bottom: 800, width: 900, height: 724 }
const COMPOSER = { left: 120, top: 600, right: 820, bottom: 700, width: 700, height: 100 }

/** Stub DOM driving the real renderMarkers: one full-width top bar, one
 *  sidebar-only header (outside the conversation column), the composer seat
 *  and the scroll body, keyed by the CSS-Modules local name hostLocalRects
 *  asks for. */
function makeDom (viewRect, scrollBodyRect) {
  const classOf = (token) => 'wSkVaW_' + token
  const el = (token, rect) => ({
    getAttribute: (attr) => (attr === 'class' ? classOf(token) : null),
    getBoundingClientRect: () => rect,
  })
  const byToken = {
    header: [
      el('header', { left: 0, top: 0, right: 1000, bottom: 64, width: 1000, height: 64 }),
      el('header', { left: 950, top: 0, right: 990, bottom: 64, width: 40, height: 64 }),
    ],
    composerSeat: [el('composerSeat', COMPOSER)],
    scrollBody: scrollBodyRect === null ? [] : [el('scrollBody', scrollBodyRect)],
  }
  return {
    querySelector: (selector) => {
      if (selector === '[data-conversation-scroll]') {
        return viewRect === null ? null : { getBoundingClientRect: () => viewRect }
      }
      if (selector === '[data-composer-card]') {
        return { getBoundingClientRect: () => COMPOSER }
      }
      return null
    },
    querySelectorAll: (selector) => {
      const m = /class\*=\\?"_(\\w+)\\?"/.exec(selector) ?? /class\*="_([A-Za-z]+)"/.exec(selector)
      return m === null ? [] : byToken[m[1]] ?? []
    },
  }
}

function runRenderMarkers (viewRect, scrollBodyRect) {
  const overlay = { style: {}, textContent: '' }
  const numLayer = { style: {}, textContent: '' }
  const prelude = ['hostLocalRects', 'conversationColumnRange', 'hostHeaderRects', 'hostComposerRects', 'clipWithHoles']
    .map(tryExtractFunction).filter((text) => text !== null).join('\n')
  const run = Function(
    'document', 'window', 'overlay', 'numLayer', 'markersSignature', 'markersSig', 'buildMarkers',
    `${prelude}\n${tryExtractFunction('renderMarkers')}\nreturn renderMarkers`,
  )
  run(makeDom(viewRect, scrollBodyRect), { innerWidth: 1000, innerHeight: 800 },
    overlay, numLayer, () => 'same', 'same', () => {})()
  return overlay.style.clipPath
}

test('renderMarkers 的 clipPath 挖掉会话列内的顶栏横带，高亮不再压住顶栏（issue #62，#63 的会话列限定）', () => {
  const clipPath = runRenderMarkers(VIEW, VIEW)
  assert.notEqual(clipPath, 'none')
  // header hole: the conversation column from the viewport top down to the scroll body
  assert.ok(
    clipPath.includes('12px 0px, 912px 0px, 912px 64px, 12px 64px, 12px 0px'),
    `header hole missing from ${clipPath}`,
  )
  // the hole must not span the whole width: sidebar file markers (#57) stay visible
  assert.ok(!clipPath.includes(', 0px 0px, 100% 0px'), 'header hole must be bounded to the conversation column')
  assert.ok(!clipPath.includes('950px'), 'sidebar-only header (x 950-990) must not be clipped at all')
})

test('输入框挖洞（issue #50）保持原样，两个洞互不影响', () => {
  const clipPath = runRenderMarkers(VIEW, VIEW)
  assert.ok(
    clipPath.includes('120px 600px, 820px 600px, 820px 700px, 120px 700px, 120px 600px'),
    `composer hole missing from ${clipPath}`,
  )
})

test('没有会话滚动容器（data 属性与 scrollBody 启发式都落空）时，标记层退回只挖输入框', () => {
  const expected = 'polygon(evenodd, 0 0, 1000px 0, 1000px 800px, 0 800px, 0 0, '
    + '120px 600px, 820px 600px, 820px 700px, 120px 700px, 120px 600px)'
  assert.equal(runRenderMarkers(null, null), expected)
})

test('零尺寸标记壳层的裁剪外框使用视口像素，缩放后重新计算（issue #81）', () => {
  const viewport = { innerWidth: 1000, innerHeight: 800 }
  const clip = Function('window', `return (${tryExtractFunction('clipWithHoles')})`)(viewport)
  assert.equal(clip([]), 'polygon(evenodd, 0 0, 1000px 0, 1000px 800px, 0 800px, 0 0)')
  viewport.innerWidth = 700
  viewport.innerHeight = 650
  assert.equal(clip([]), 'polygon(evenodd, 0 0, 700px 0, 700px 650px, 0 650px, 0 0)')
  assert.doesNotMatch(clip([COMPOSER]), /%/, '百分比会按零尺寸壳层计算，导致正文标记不可见')
})

test('data 属性缺失但 scrollBody 可见时，会话列退回类名启发式（不依赖单一宿主钩子）', () => {
  const clipPath = runRenderMarkers(null, VIEW)
  assert.ok(
    clipPath.includes('12px 0px, 912px 0px, 912px 64px, 12px 64px, 12px 0px'),
    `fallback header hole missing from ${clipPath}`,
  )
})

test('conversationColumnRange：data 属性优先，其缺失时退回 scrollBody 并集', () => {
  const run = (viewRect, scrollBodyRect) => Function(
    'document', 'window',
    `${tryExtractFunction('hostLocalRects')}\nreturn (${tryExtractFunction('conversationColumnRange')})`,
  )(makeDom(viewRect, scrollBodyRect), { innerHeight: 800 })()
  const col = run(VIEW, null)
  assert.deepEqual({ left: col.left, right: col.right, top: col.top }, { left: 12, right: 912, top: 76 })
  const fallback = run(null, VIEW)
  assert.deepEqual(
    { left: fallback.left, right: fallback.right, top: fallback.top },
    { left: 12, right: 912, top: 76 },
  )
  assert.equal(run(null, null), null)
})

test('编号胶囊的顶部下限抬到会话列上沿 + 4px，原文已滚入顶栏之下时不钳制（issue #62）', () => {
  const build = source.slice(source.indexOf('function buildMarkers()'), source.indexOf('// ---------- 动作 ----------'))
  assert.match(build, /var chipFloor = col !== null \? col\.top \+ 4 : 4/,
    'floor comes from the conversation column, defaulting to the viewport edge')
  assert.match(build, /anchor\.top >= chipFloor && chipTop < chipFloor/,
    'clamp only while the passage itself starts below the floor — passages scrolled under the header keep the skip rule (#65)')
})
