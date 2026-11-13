// 标记层滚动性能回归：元素池增量更新、遮挡区 clipPath 条件写入、
// quote 定位 Range 缓存、批注增删时的池元素生命周期。
//
// 这里用「源码切片 + Function 驱动真实 renderMarkers/buildMarkers」的方式，
// 不修改 client.js（不给产品代码加测试钩子）：提取的函数自包含，DOM 宿主
// 几何全部由 stub 提供，行为断言跑的是落盘的真实实现。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function sliceBetween (startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `client.js 应定义 ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.ok(end > start, `${startMarker} 之后应出现 ${endMarker}`)
  return source.slice(start, end)
}

// Source slice for one `function name(...) { ... }` by brace matching.
function functionSource (name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ''
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

// ---------- stub DOM / 驱动真实渲染函数 ----------

const rect = (left, top, width, height) => ({
  left, top, right: left + width, bottom: top + height, width, height,
})

function stubElement (style = {}) {
  const el = {
    className: '',
    style,
    textContent: undefined,
    parentNode: null,
    children: [],
    listeners: {},
    addEventListener (type, fn) {
      (el.listeners[type] ?? (el.listeners[type] = [])).push(fn)
    },
    appendChild (child) {
      if (child.parentNode !== null) child.parentNode.removeChild(child)
      child.parentNode = el
      el.children.push(child)
      return child
    },
    removeChild (child) {
      const index = el.children.indexOf(child)
      if (index !== -1) el.children.splice(index, 1)
      child.parentNode = null
      return child
    },
  }
  return el
}

/** 驱动真实 renderMarkers/buildMarkers 的最小 harness。
 *
 *  几何用可变对象模拟滚动/尺寸变化；宿主元素引用（hostLocalEls、
 *  conversationViewEl、composerCardEl）由真实函数缓存，getBoundingClientRect
 *  每次读可变几何，因此无需 invalidate 就能模拟「元素没变、矩形变了」。
 *  唯一注入的桩是 locateQuote：慢路径会被计数，用来证明 Range 缓存生效。 */
function makeHarness () {
  const geom = {
    view: rect(12, 76, 900, 724),
    header: rect(0, 0, 1000, 64),
    composerSeat: rect(120, 600, 700, 100),
    card: rect(120, 600, 700, 100),
    scrollBody: rect(12, 76, 900, 724),
  }

  const hostElement = (local, read) => ({
    getAttribute: (name) => (name === 'class' ? `wSkVaW_${local}` : null),
    getBoundingClientRect: read,
  })
  const viewEl = { getBoundingClientRect: () => geom.view }
  const cardEl = { getBoundingClientRect: () => geom.card }
  const localEls = {
    header: [hostElement('header', () => geom.header)],
    composerSeat: [hostElement('composerSeat', () => geom.composerSeat)],
    scrollBody: [hostElement('scrollBody', () => geom.scrollBody)],
  }

  const documentStub = {
    querySelector (selector) {
      if (selector === '[data-conversation-scroll]') return viewEl
      if (selector === '[data-composer-card]') return cardEl
      return null
    },
    querySelectorAll (selector) {
      const match = /class\*="_([A-Za-z]+)"/.exec(selector)
      return match === null ? [] : localEls[match[1]] ?? []
    },
    createElement: () => stubElement(),
  }

  const overlayStyle = {}
  let clipWrites = 0
  let clipValue
  Object.defineProperty(overlayStyle, 'clipPath', {
    get: () => clipValue,
    set: (value) => { clipWrites++; clipValue = value },
  })
  const overlay = stubElement(overlayStyle)
  const numLayer = stubElement()
  const ui = { quotes: [], mode: 'closed', editingId: null }
  const windowStub = { innerWidth: 1000, innerHeight: 800 }

  let locateCalls = 0
  let sourceofCalls = 0
  let locateOverride
  let sourceFactory = () => null
  const makeRange = (q) => ({
    startContainer: { isConnected: true },
    commonAncestorContainer: { isConnected: true },
    toString: () => q.text,
    getClientRects: () => q.__rects.current,
  })
  const newQuote = (text, top, left = 100) => {
    const q = { text, __rects: { current: [rect(left, top, 200, 20)] } }
    q.__range = makeRange(q)
    return q
  }
  // 真实 locateQuote 的慢路径：返回一个「新定位」的 live Range 并计数。
  const locateQuote = (text, saved) => {
    locateCalls++
    if (locateOverride !== undefined) return locateOverride === null ? null : saved.__range
    saved.__range = makeRange(saved)
    return saved.__range
  }
  // documentSourceOf 的桩：默认 null（普通正文批注），文件批注场景按用例返回来源。
  const documentSourceOf = (node) => {
    sourceofCalls++
    return sourceFactory(node)
  }
  const openEditorFor = () => {}

  const prelude = [
    'hostLocalEls', 'hostLocalRects', 'conversationViewEl', 'composerCardEl',
    'conversationColumnRange', 'hostHeaderRects', 'hostComposerRects', 'markersSignature',
    'clipWithHoles', 'quoteRects', 'locateQuoteCached', 'sourceAlive', 'rangeAlive',
    'markerEntryFor', 'hlAt', 'chipAt', 'placeMarkerEl', 'hideMarkerEl',
    'clearMarkerEls', 'clearMarkers', 'previewActive', 'paintPreviewHighlight', 'tagAt', 'tagOf',
    'renderMarkers', 'buildMarkers',
  ].map(functionSource).filter((text) => text !== '').join('\n')

  const factory = Function(
    'document', 'window', 'overlay', 'numLayer', 'ui',
    'locateQuote', 'openEditorFor', 'getComputedStyle', 'Element', 'DOMRect',
    'documentSourceOf',
    `var markerEntries = []
     var previewEntry = { hls: [] }
     var annotationTags = ['Yes', 'No']
     var markerEntryOf = new WeakMap()
     var locateCache = new WeakMap()
     var markerHoles = null
     var markersSig = null
     var domMutationSeq = 0
     ${prelude}
     return {
       render: renderMarkers,
       entries: function () { return markerEntries },
       tags: annotationTags,
     }`,
  )(
    documentStub, windowStub, overlay, numLayer, ui,
    locateQuote, openEditorFor,
    () => ({ overflowX: 'visible', overflowY: 'visible' }),
    class Element {},
    // quoteRects 的 sourceUrl 分支会 new DOMRect(...) 裁剪矩形，stub 需可构造。
    class StubDOMRect {
      constructor (left, top, width, height) {
        this.left = left
        this.top = top
        this.width = width
        this.height = height
        this.right = left + width
        this.bottom = top + height
      }
    },
    documentSourceOf,
  )

  return {
    overlay,
    numLayer,
    ui,
    tags: factory.tags,
    newQuote,
    setQuotes (quotes) { ui.quotes = quotes },
    render () { factory.render() },
    entries () { return factory.entries() },
    clipPathWrites () { return clipWrites },
    clipPath () { return clipValue },
    locateCalls () { return locateCalls },
    sourceofCalls () { return sourceofCalls },
    setDocumentSource (fn) { sourceFactory = fn },
    setLocateOverride (value) { locateOverride = value },
    scrollBy (dy) {
      for (const q of ui.quotes) {
        q.__rects.current = q.__rects.current.map((r) => rect(r.left, r.top + dy, r.width, r.height))
      }
    },
    setComposerRect (next) { geom.composerSeat = next },
    /** 模拟 React 重渲染替换文本节点：缓存的 Range 失去连接。 */
    breakRanges () {
      for (const q of ui.quotes) q.__range.startContainer.isConnected = false
    },
  }
}

const sameElements = (actual, expected) => {
  assert.equal(actual.length, expected.length)
  for (let i = 0; i < expected.length; i++) assert.equal(actual[i], expected[i], `元素池第 ${i} 个元素应被复用`)
}

// ---------- 行为回归 ----------

test('滚动只更新 transform：overlay/numLayer 的元素池被复用，不重建且数量不增长', () => {
  const h = makeHarness()
  h.setQuotes([h.newQuote('alpha', 120), h.newQuote('beta', 200), h.newQuote('gamma', 280)])
  h.render()

  const highlights = h.overlay.children.slice()
  const chips = h.numLayer.children.slice()
  assert.equal(highlights.length, 3, '三条批注各一个高亮块')
  assert.equal(chips.length, 3, '三条批注各一个编号')
  assert.equal(h.entries().length, 3)
  assert.equal(highlights[0].style.transform, 'translate(100px,120px)')
  assert.equal(chips[0].style.transform, 'translate(96px,100px)')
  assert.equal(h.locateCalls(), 3, '首帧每条批注定位一次')

  // 仅滚动（内容、批注集、遮挡区都不变）
  h.scrollBy(-20)
  h.render()

  sameElements(h.overlay.children, highlights)
  sameElements(h.numLayer.children, chips)
  assert.equal(h.overlay.children.length, 3, '滚动不应让元素池增长')
  assert.equal(h.numLayer.children.length, 3)
  assert.equal(highlights[0].style.transform, 'translate(100px,100px)', '第二次渲染后 transform 更新为新坐标')
  assert.equal(chips[0].style.transform, 'translate(96px,80px)')
  assert.equal(h.locateCalls(), 3, '滚动时 Range 缓存命中，不再跑慢路径')
})

test('遮挡区几何不变时不重写 clipPath，变化时才写', () => {
  const h = makeHarness()
  h.setQuotes([h.newQuote('alpha', 120)])
  h.render()

  assert.equal(h.clipPathWrites(), 1, '首帧必须写一次 clipPath')
  const first = h.clipPath()
  assert.match(first, /polygon\(evenodd/)
  assert.equal(h.numLayer.style.clipPath, first, '编号层共用同一条裁剪路径')

  h.render()
  assert.equal(h.clipPathWrites(), 1, '遮挡区签名不变时第二轮不写 clipPath')
  assert.equal(h.clipPath(), first)

  h.scrollBy(-10)
  h.render()
  assert.equal(h.clipPathWrites(), 1, '纯滚动不改变遮挡区，仍不写 clipPath')
  assert.equal(h.clipPath(), first)

  h.setComposerRect(rect(120, 620, 700, 80))
  h.render()
  assert.equal(h.clipPathWrites(), 2, '输入区几何变化才重写 clipPath')
  assert.notEqual(h.clipPath(), first)
  assert.equal(h.numLayer.style.clipPath, h.clipPath())
})

test('内容稳定时 locateQuote 慢路径不被重复调用；Range 失效后重新定位', () => {
  const h = makeHarness()
  h.setQuotes([h.newQuote('alpha', 120), h.newQuote('beta', 200)])
  h.render()
  assert.equal(h.locateCalls(), 2)

  h.scrollBy(-30)
  h.render()
  h.render()
  assert.equal(h.locateCalls(), 2, '缓存 Range 仍存活时，滚动不应重复跑文本扫描')

  // 宿主重渲染替换文本节点：isConnected=false → 缓存必须失效并重新定位
  h.breakRanges()
  h.render()
  assert.equal(h.locateCalls(), 4, '失去连接的 Range 不能复用，每条批注重新定位一次')
})

test('批注增删：池元素随批注集创建/移除，不泄漏也不残留', () => {
  const h = makeHarness()
  h.render()
  assert.equal(h.overlay.children.length, 0)
  assert.equal(h.numLayer.children.length, 0)

  const alpha = h.newQuote('alpha', 120)
  const beta = h.newQuote('beta', 200)
  const gamma = h.newQuote('gamma', 280)
  h.setQuotes([alpha, beta, gamma])
  h.render()
  assert.equal(h.overlay.children.length, 3, '批注从 0 变 N 时标记正确创建')
  assert.equal(h.numLayer.children.length, 3)
  assert.equal(h.entries().length, 3)

  const keptHighlight = h.overlay.children[0]
  const keptChip = h.numLayer.children[0]
  h.setQuotes([alpha])
  h.render()
  assert.equal(h.overlay.children.length, 1, '删除的批注对应池元素从 overlay 移除')
  assert.equal(h.numLayer.children.length, 1, '删除的编号从编号层移除')
  assert.equal(h.entries().length, 1, 'markerEntries 不残留已删除批注')
  assert.equal(h.overlay.children[0], keptHighlight, '保留的批注继续复用原元素')
  assert.equal(h.numLayer.children[0], keptChip)
  assert.equal(keptHighlight.parentNode, h.overlay)
  assert.equal(keptChip.parentNode, h.numLayer)

  h.setQuotes([])
  h.render()
  assert.equal(h.overlay.children.length, 0, '全部删除后标记层清空')
  assert.equal(h.numLayer.children.length, 0)
  assert.equal(h.entries().length, 0)
})

test('新增批注的预览高亮：按编辑状态出现/撤销，与已保存批注共用同一标记层', () => {
  const h = makeHarness()
  // 模拟 settle 时缓存的选区 Range（跨两行）。
  const preview = {
    startContainer: { isConnected: true },
    getClientRects: () => [rect(100, 120, 200, 20), rect(100, 180, 120, 20)],
  }
  h.ui.mode = 'editing'
  h.ui.selectionRange = preview
  h.render()
  assert.equal(h.overlay.children.length, 2, '编辑浮窗打开时按选区矩形画两块预览高亮')
  assert.equal(h.overlay.children[0].className, 'dsh-ann-hl-preview',
    '预览高亮用独立类名，正式标记选择器 .dsh-ann-hl 不会被隐藏的预览元素干扰')
  assert.equal(h.overlay.children[0].style.transform, 'translate(100px,120px)')
  assert.equal(h.overlay.children[1].style.transform, 'translate(100px,180px)')

  // 正文移动（滚动/布局变化）后预览高亮跟随 Range 的新位置。
  const moved = {
    startContainer: { isConnected: true },
    getClientRects: () => [rect(100, 80, 200, 20), rect(100, 140, 120, 20)],
  }
  h.ui.selectionRange = moved
  h.render()
  assert.equal(h.overlay.children.length, 2, '预览元素池复用，不随滚动增长')
  assert.equal(h.overlay.children[0].style.transform, 'translate(100px,80px)', '滚动后预览高亮跟随原文')

  // 已有正式批注 + 预览高亮共存，元素池互不干扰。
  h.setQuotes([h.newQuote('alpha', 300)])
  h.render()
  assert.equal(h.overlay.children.length, 3, '正式高亮与预览高亮各占自己的池元素')
  const kept = h.overlay.children.slice(0, 2)

  // 撤销预览（放弃/保存）：预览元素就地隐藏，正式标记保留。
  h.ui.selectionRange = null
  h.render()
  assert.equal(h.overlay.children[0].style.display, 'none', '撤销后预览高亮隐藏')
  assert.equal(h.overlay.children[1].style.display, 'none')
  assert.notEqual(h.overlay.children[2].style.display, 'none', '正式批注高亮不受撤销影响')
  assert.equal(h.overlay.children[0], kept[0], '隐藏的预览元素留在池里供下次复用')
})

test('编号后跟随标签：note 是现存标签才显示，改写或删除标签后消失', () => {
  const h = makeHarness()
  const q = h.newQuote('alpha', 120)
  q.note = 'Yes'
  h.setQuotes([q])
  h.render()
  const tagEls = () => h.numLayer.children.filter(el => el.className === 'dsh-ann-num-tag')
  assert.equal(tagEls().length, 1, 'note 是现存标签时应渲染标签文字')
  const tag = tagEls()[0]
  assert.equal(tag.textContent, 'Yes')
  assert.notEqual(tag.style.display, 'none')
  assert.equal(tag.style.transform, 'translate(116px,100px)', '标签跟在编号右侧（编号宽 16 + 4px 间距）')

  // 重新编辑把 note 改成非标签文字 → 标签失效，编号保留
  q.note = '自由批注'
  h.render()
  assert.equal(tag.style.display, 'none', 'note 不是现存标签时标签消失')
  assert.equal(h.numLayer.children.filter(el => el.className === 'dsh-ann-num').length, 1, '编号仍在')

  // note 恢复成标签；再把它从持久化标签列表里删掉 → 已有批注也不再显示
  q.note = 'Yes'
  h.render()
  assert.notEqual(tag.style.display, 'none')
  h.tags.length = 0
  h.tags.push('No')
  h.render()
  assert.equal(tag.style.display, 'none', '标签被删除后已有批注不再显示它')
  assert.equal(tagEls().length, 1, '标签元素池复用，不重建')
})

test('编号 hover 提示：显示批注内容前 10 个字符，标签批注不提示', () => {
  const h = makeHarness()
  const long = h.newQuote('alpha', 120)
  long.note = '这是一条超过十个字符的批注内容，用来验证截断'
  const tagged = h.newQuote('beta', 200)
  tagged.note = 'Yes'
  const empty = h.newQuote('gamma', 280)
  empty.note = ''
  h.setQuotes([long, tagged, empty])
  h.render()
  const chips = h.numLayer.children.filter((el) => el.className === 'dsh-ann-num')
  assert.equal(chips.length, 3)
  assert.equal(chips[0].title, '这是一条超过十个字符', '只取前 10 个字符')
  assert.equal(chips[1].title, '', '标签批注已有标签文字，不显示提示')
  assert.equal(chips[2].title, '', '没有批注内容时不显示提示')

  // note 改写后提示跟着更新
  long.note = '短批注'
  h.render()
  assert.equal(chips[0].title, '短批注')
  long.note = ''
  h.render()
  assert.equal(chips[0].title, '')
})

test('文件批注：缓存命中前校验来源文件，切文件后旧标记不再继承', () => {
  const h = makeHarness()
  const q = h.newQuote('alpha', 120)
  q.sourceUrl = 'dsh-resource://file/session/session/docs/a.md'
  q.sourcePath = 'docs/a.md'
  h.setQuotes([q])
  const source = (url) => () => ({ sourceUrl: url, sourcePath: 'docs/x.md', root: { getClientRects: () => [1] } })
  h.setDocumentSource(source(q.sourceUrl))
  h.render()
  assert.equal(h.locateCalls(), 1)

  h.scrollBy(-10)
  h.render()
  assert.equal(h.locateCalls(), 1, '来源文件未变时缓存继续命中，不重复慢路径')

  // 宿主只改了 data-textpreview-url（文本节点未重建）：Range 仍 alive，但来源已不匹配。
  h.setDocumentSource(source('dsh-resource://file/session/session/docs/b.md'))
  h.setLocateOverride(null) // 慢路径在 b.md 里定位不到原文
  h.render()
  assert.equal(h.locateCalls(), 2, 'sourceUrl 不匹配时必须退回慢路径重新定位')
  assert.equal(h.numLayer.children[0].style.display, 'none', '旧文件批注不得继承到新文件')
})

// ---------- 源码结构守卫（旧实现会在这些断言上失败） ----------

test('renderMarkers 只在遮挡区签名变化时写 clipPath，签名不再遍历 quotes', () => {
  const render = sliceBetween('function renderMarkers()', 'function buildMarkers()')
  assert.match(render, /var holes = hostComposerRects\(\)\.concat\(hostHeaderRects\(\)\)/)
  assert.match(render, /if \(sig !== markersSig\)/, 'clipPath 写入必须由遮挡区签名变化驱动')
  assert.match(render, /markersSig = sig/)
  assert.match(render, /numLayer\.style\.clipPath = overlay\.style\.clipPath/, '编号层共用裁剪路径')
  assert.match(render, /markerHoles = holes/, '本帧遮挡区传给 buildMarkers，避免重复查询')
  assert.doesNotMatch(render, /ui\.quotes/, 'renderMarkers 不再遍历 quotes 做全量重建')

  const sig = sliceBetween('function markersSignature(', 'function hostLocalEls(')
  assert.match(sig, /blockers/, '签名只算遮挡区矩形')
  assert.doesNotMatch(sig, /quotes/, '签名不再计入批注内容')
})

test('buildMarkers 是元素池增量更新：复用元素、transform 定位，不逐帧清空重建', () => {
  const build = sliceBetween('function buildMarkers()', '// ---------- 标记元素池 ----------')
  assert.match(build, /markerEntryFor\(q\)/, '每条批注复用固定 entry')
  assert.match(build, /placeMarkerEl\(hl,/, '高亮块走池化定位')
  assert.match(build, /placeMarkerEl\(chip,/, '编号走池化定位')
  assert.match(build, /hideMarkerEl\(entry\.chip\)/, '不可见的编号就地隐藏而不是重建')
  assert.doesNotMatch(build, /overlay\.textContent = ''/, '不再每帧清空高亮层')
  assert.doesNotMatch(build, /numLayer\.textContent = ''/, '不再每帧清空编号层')
  assert.equal((build.match(/\bclearMarkers\(\)/g) ?? []).length, 1, '只在批注集为空时整层清空一次')
  assert.match(build, /hostLocalRects\('scrollBody'\)[\s\S]*?conversationColumnRange\(\)/, 'viewers/col 每帧只问一次')

  const pool = sliceBetween('// ---------- 标记元素池 ----------', '// ---------- 动作 ----------')
  assert.match(pool, /var markerEntries = \[\]/)
  assert.match(pool, /markerEntryOf = typeof WeakMap === 'function' \? new WeakMap\(\)/, 'entry 按批注对象复用')
  const place = sliceBetween('function placeMarkerEl(', 'function hideMarkerEl(')
  assert.match(place, /el\.__annGeom/, '几何缓存在元素上，用于判断是否需要写 style')
  assert.match(place, /translate\(' \+ x \+ 'px,' \+ y \+ 'px\)/, 'fixed 标记层用 transform 定位（不触发布局）')
  assert.match(place, /if \(g\.x !== x \|\| g\.y !== y\)/, '只有坐标变化才写 style')
  const clear = sliceBetween('function clearMarkerEls(', 'function clearMarkers(')
  assert.match(clear, /removeChild/, '删除批注时池元素真正从 DOM 移除')
})

test('hostLocalEls / conversationViewEl / composerCardEl / composerSeatOf 有缓存且可统一失效', () => {
  const host = sliceBetween('function hostLocalEls(local)', 'function invalidateHostLocalRects(')
  assert.match(host, /hostLocalEls\.cache/, '宿主元素列表按 local 名缓存')
  assert.match(host, /if \(els !== undefined\) return els/, '命中缓存不重复 querySelectorAll')

  const invalidate = sliceBetween('function invalidateHostLocalRects()', 'function hostLocalRects(')
  assert.match(invalidate, /hostLocalEls\.cache = null/)
  assert.match(invalidate, /conversationViewEl\.cache = undefined/)
  assert.match(invalidate, /composerCardEl\.cache = undefined/)
  assert.match(invalidate, /composerSeatOf\.cache = undefined/)

  const view = sliceBetween('function conversationViewEl()', 'function composerCardEl(')
  assert.match(view, /conversationViewEl\.cache === undefined/)
  assert.match(view, /querySelector\('\[data-conversation-scroll\]'\)/)

  const seat = sliceBetween('function composerSeatOf(card)', '// 胶囊内容只在条数/文案变化时重建')
  assert.match(seat, /var cached = composerSeatOf\.cache/, 'seat 结果按输入卡片引用缓存')
  assert.match(seat, /cached\.card === card/, '换卡片引用后重新计算')

  const observer = sliceBetween('var observer = new MutationObserver(', 'observer.observe(')
  assert.match(observer, /mutations\[i\]\.type === 'childList'/, '只有 childList 批次才可能失效几何缓存')
  assert.match(observer, /if \(hasRowInsert\) invalidateHostLocalRects\(\)/)

  const decorate = sliceBetween('function decorateAll()', 'var decoTimer = null')
  assert.match(decorate, /invalidateHostLocalRects\(\)/, '1s 兜底轮询也会失效缓存（只换 class 的视图变化）')
})

test('locateQuoteCached 用 rangeAlive + sourceAlive 快路径，滚动不再重复文本扫描', () => {
  const cached = sliceBetween('function locateQuoteCached(q)', 'function sourceAlive(')
  assert.match(cached, /rangeAlive\(cached\.range, q\.text\) && sourceAlive\(cached\.range, q\)/,
    '缓存命中必须同时满足 Range 存活与来源文件未变')
  assert.match(cached, /locateQuote\(q\.text, q\)/, '只有缓存失效才走慢路径')
  assert.match(cached, /locateCache\.set\(q, \{ range: range \}\)/, '定位成功写回缓存')
  assert.match(cached, /cached\.domSeq === domMutationSeq/,
    '定位失败后宿主 DOM 未变化时直接复用失败结果，滚动不重复全量扫描')
  assert.match(cached, /locateCache\.set\(q, \{ range: null, domSeq: domMutationSeq \}\)/,
    '定位失败按 DOM 版本记录，DOM 变化（加载更早/重渲染）后才重试')

  const sourceGuard = sliceBetween('function sourceAlive(', 'function rangeAlive(')
  assert.match(sourceGuard, /if \(!q\.sourceUrl\) return true/, '普通正文批注不做额外工作')
  assert.match(sourceGuard, /documentSourceOf\(range\.commonAncestorContainer\)/, '文件批注要求 Range 仍属于同一预览源')
  assert.match(sourceGuard, /source\.sourceUrl !== q\.sourceUrl/, '切换文件（属性先行、文本未重建）时必须失效')
  assert.match(sourceGuard, /source\.root\.getClientRects\(\)\.length > 0/, '预览源不可见时也不能复用缓存')

  const alive = sliceBetween('function rangeAlive(', '// ---------- 动作 ----------')
  assert.match(alive, /startContainer\.isConnected/, 'React 替换文本节点后必须重新定位')
  assert.match(alive, /range\.toString\(\)/, '文本被改写后必须重新定位')

  const build = sliceBetween('function buildMarkers()', '// ---------- 标记元素池 ----------')
  assert.match(build, /locateQuoteCached\(q\)/, 'buildMarkers 只走缓存版定位')
  assert.doesNotMatch(build, /locateQuote\(/, 'buildMarkers 不得直接调用慢路径')
})

test('新增批注预览高亮：点过「批注/标签」才出现、收起标签保持、关闭时撤销', () => {
  const settle = sliceBetween('function onSelection()', 'function clearSettle()')
  assert.match(settle, /ui\.selectionRange = r\.cloneRange\(\)/,
    'settle 时缓存选区 Range（点击工具条后浏览器会清掉选区）')
  assert.match(settle, /ui\.previewArmed = false/,
    '新选区出现工具条时复位预览开关（不显示预览，避免与系统选区渲染重叠）')
  assert.doesNotMatch(settle, /renderMarkers\(\)/,
    '工具条刚随选区出现时不画预览')

  const enter = sliceBetween('function enterEditing()', 'function openEditorFor(')
  assert.match(enter, /currentSelectionRange\(\) \|\| ui\.selectionRange/,
    '进入编辑时优先实时选区，回退到 settle 缓存的 Range')
  assert.match(enter, /ui\.selectionRange = range/, '缓存的 Range 直接作为预览高亮的 Range')
  assert.match(enter, /ui\.previewArmed = true/, '点「批注」进入编辑浮窗即打开预览')
  assert.match(enter, /paintPreviewHighlight\(\)/, '进入编辑浮窗立即绘制预览高亮')
  assert.match(enter, /captureAnchor\(ui\.quote, range\)/, '预览高亮与保存锚点共用同一个 Range')

  const close = sliceBetween('function closeToolbar()', '// ---------- 输入框旁的批注标签')
  assert.match(close, /ui\.selectionRange = null/, '关闭后不残留上一次的选区 Range')
  assert.match(close, /ui\.previewArmed = false/, '关闭工具条时复位预览开关')
  assert.match(close, /paintPreviewHighlight\(\)/, '放弃本次批注时撤销预览高亮')

  const toggle = sliceBetween('function toggleTagPanel()', 'function clampBarToViewport(')
  assert.match(toggle, /ui\.previewArmed = true/, '点「标签」后打开预览')
  assert.match(toggle, /paintPreviewHighlight\(\)/, '展开/收起标签面板时同步预览（收起也保持）')

  const preview = sliceBetween('function previewActive()', 'function paintPreviewHighlight()')
  assert.match(preview, /if \(ui\.mode !== 'actions' \|\| !ui\.previewArmed\) return false/,
    '只有点过「批注/标签」后才显示预览（工具条阶段不显示）')
  assert.match(preview, /ui\.mode === 'editing' && ui\.editingId === null/, '新增批注的编辑浮窗同样显示预览')
  assert.match(preview, /ui\.quotes\.some\(function \(q\)/, '原文已批注过时不再叠加预览高亮')

  const update = sliceBetween('function paintPreviewHighlight()', 'function locateQuoteCached(')
  assert.match(update, /var active = previewActive\(\)/, '预览高亮按 previewActive() 条件绘制')
  assert.match(update, /if \(!active && previewEntry\.hls\.length === 0\) return/,
    '没有预览时快速返回：滚动路径每帧都会调用')
  assert.match(update, /quoteRects\(range, ui\.source \|\| \{\}\)/,
    '预览高亮与正式标记共用选区矩形计算（含文件预览裁剪）')
  assert.match(update, /hlAt\(previewEntry, shown, 'preview'\)/, '预览高亮复用正式标记的元素池')
  assert.match(update, /hideMarkerEl\(previewEntry\.hls\[j\]\)/, '撤销后就地隐藏而不是重建')

  const layout = sliceBetween('function onLayoutChange()', "window.addEventListener('scroll', onLayoutChange, true)")
  assert.match(layout, /ui\.quotes\.length > 0 \|\| previewActive\(\)/,
    '只有预览、还没保存任何批注时滚动也要刷新标记层')

  const open = sliceBetween('function openEditorFor(', 'function buildBlock(')
  assert.match(open, /ui\.selectionRange = null/, '编辑已有批注不显示预览高亮（它本来就有正式高亮）')
})

test('快捷标签：持久化走 /annotation-tags，选择标签直接生成带标签内容的批注', () => {
  assert.match(source, /fetch\('\/annotation-tags', \{ credentials: 'same-origin' \}\)/, '启动时从 host 读取标签')
  assert.match(source, /JSON\.stringify\(\{ action: action, tag: tag \}\)/, '新增/删除走 POST /annotation-tags')
  assert.match(source, /var DEFAULT_TAGS = \['Yes', 'No'\]/, '默认标签 Yes / No')

  const choose = sliceBetween('function chooseTag(', 'function positionEditor(')
  assert.match(choose, /existing\.note = tag/, '同一原文已有批注时替换标签（每条批注最多一个标签）')
  assert.match(choose, /ui\.quotes\.push\(\{/, '否则直接新增一条批注')
  assert.match(choose, /note: tag/, '标签文本写入批注内容')
  assert.match(choose, /closeToolbar\(\)/, '创建后关闭工具条，走默认发送逻辑')

  const build = sliceBetween('function buildMarkers()', '// ---------- 标记元素池 ----------')
  assert.match(build, /var tagText = tagOf\(q\)/, '编号后跟随标签按 note 判定')
  assert.match(build, /placeMarkerEl\(tagEl,/, '标签与编号共用元素池定位')

  const tagOfFn = sliceBetween('function tagOf(', '/** 定位结果缓存')
  assert.match(tagOfFn, /annotationTags\.indexOf\(note\) !== -1/, '标签必须仍在持久化列表中')

  const panel = sliceBetween('function tagPanel(', 'function tagPill(')
  assert.match(panel, /annotationTags\.length/, '面板按持久化标签渲染')
  assert.match(panel, /dsh-ann-tag-add/, '末尾有新增按钮')
  assert.match(panel, /add\.addEventListener\('pointerdown'/, '「+」在指针按下时先处理，避免空输入被 blur 抢先移除又重开')
  assert.match(panel, /var input = panel\.querySelector\('\.dsh-ann-tag-input'\)/, '点击「+」先看输入框是否已打开')
  assert.match(panel, /input\.remove\(\)/, '输入框为空时再点「+」收起，恢复未点击状态')
  assert.match(panel, /if \(input === null\) \{\s*showTagInput\(panel, add\)/, '没有输入框时点「+」才打开输入')

  const close = sliceBetween('function closeToolbar()', '// ---------- 输入框旁的批注标签')
  assert.match(close, /tagPanelOpen = false/, '关闭工具条时收起标签面板')

  assert.match(source, /\.dsh-ann-tag-del \{/, 'hover 删除叉样式存在')
  assert.match(source, /\.dsh-ann-num-tag \{/, '编号后标签样式存在')
  // 字重保持「不加粗」即可；字号由用户按观感微调（当前 11px / 450）。
  assert.doesNotMatch(source, /font-weight: 600; line-height: 14px/,
    '编号后标签不加粗（加粗会让小字号文字发虚）')
  assert.match(source, /\.dsh-ann-tag-toggle \{/, '标签入口是紧凑图标按钮（省出工具条宽度）')
  assert.match(source, /var tagToggle = document\.createElement\('div'\)/,
    '标签入口不是原生 button（宿主 e2e 的 .dsh-ann-bar button 只命中批注按钮）')
  assert.match(source, /tagToggle\.setAttribute\('role', 'button'\)/, '标签入口保留 role=button 可访问语义')
  assert.match(source, /\.dsh-ann-split \{/, '标签入口与「批注」之间用细线分隔、视觉上融合')
  assert.match(source, /ICONS\.tag\(\)/, '标签入口使用 tag 图标')
  assert.match(source, /margin: 0 -2px/, '细线两侧用负 margin 吃掉 bar 的 gap，图标贴近「批注」')
  assert.match(source, /margin-left: -5px/, '图标按钮再向「批注」靠拢')
  assert.doesNotMatch(source, /@keyframes dsh-ann-tags-reveal/, '展开不再用一次性滑入动画')
  assert.doesNotMatch(source, /@keyframes dsh-ann-tag-in/, '浮岛内容不再逐个动画（用户要求去掉）')
  assert.match(source, /panel\.style\.maxWidth = '0px'/, '展开从 0 宽开始')
  assert.match(source, /panel\.scrollWidth/, '先量出内容宽度再展开')
  assert.match(source, /panel\.style\.maxWidth = targetWidth \+ 'px'/, '用 max-width transition 逐渐撑开工具条')
  assert.match(source, /panel\.style\.overflow = 'visible'/, '展开完成后放开裁剪（hover 删除叉可溢出）')
  assert.match(source, /prefers-reduced-motion: reduce/, '减少动态效果时直接展开、不播动画')
  assert.doesNotMatch(source, /padding: 6px 2px 0/, '标签面板不再加顶部 padding（否则浮岛标签整体下移、不垂直居中）')
  assert.match(source, /\.dsh-ann-tags \{ display: inline-flex; align-items: center; gap: 6px; padding: 0 2px;/,
    '标签面板内容与工具条垂直居中')

  const toggle = sliceBetween('function toggleTagPanel(', 'function refreshTagPanel(')
  assert.match(toggle, /tagPanelOpen = !tagPanelOpen/, '点击标签图标切换展开状态')
  assert.match(toggle, /bar\.querySelector\('\.dsh-ann-tag-toggle'\)/, '直接操作现有工具条上的标签按钮')
  assert.match(toggle, /bar\.appendChild\(panel\)/, '展开只插入面板（不整条重建）')
  assert.match(toggle, /panel\.__annClosing = true/, '收起先进入 closing 状态')
  assert.match(toggle, /panel\.style\.maxWidth = Math\.round\(panel\.getBoundingClientRect\(\)\.width\) \+ 'px'/,
    '收起从当前宽度开始过渡')
  assert.match(toggle, /panel\.style\.maxWidth = '0px'/, '收起过渡到 0 宽')
  assert.match(toggle, /setTimeout\(removePanel, 300\)/, '收起动画结束后才从 DOM 移除')
  assert.match(toggle, /panel\.__annClosing === true[\s\S]*?panel\.style\.maxWidth = resumeWidth \+ 'px'/,
    '收起动画中再点展开会平滑续开')
  assert.match(toggle, /panel\.style\.transition = 'max-width \.24s linear, opacity \.18s linear'/,
    '展开匀速（linear），结尾不减速')
  assert.match(toggle, /panel\.style\.transition = 'max-width \.22s linear, opacity \.16s linear'/,
    '收起匀速（linear）')
  assert.doesNotMatch(toggle, /cubic-bezier/, '过渡不再使用缓出曲线，避免末尾变慢显得卡')

  const renderSrc = sliceBetween('function render()', 'function toggleTagPanel(')
  assert.match(renderSrc, /tagToggle\.addEventListener\('click', activateTagToggle\)/,
    '点击标签图标走局部展开，不触发整条 render（否则批注按钮会闪）')
  assert.match(renderSrc, /function activateTagToggle\(\) \{[\s\S]*?toggleTagPanel\(\)/,
    '点击/键盘激活都切到 toggleTagPanel')

  const refresh = sliceBetween('function refreshTagPanel(', '/** 工具条内向右展开的标签面板')
  assert.match(refresh, /replaceChild\(tagPanel\(\), old\)/, '标签数据变化只重填面板内容')

  const markerBuild = sliceBetween('function buildMarkers()', '// ---------- 标记元素池 ----------')
  assert.match(markerBuild, /var chipTitle = ''/, '编号 hover 提示按需构造')
  assert.match(markerBuild, /Array\.from\(noteText\.replace\(\/\\s\+\/g, ' '\)\)\.slice\(0, 10\)\.join\(''\)/,
    '提示只显示批注内容前 10 个字符')
  assert.match(markerBuild, /tagText === ''/, '标签批注不显示提示')
  assert.match(markerBuild, /chip\.title = chipTitle/, '提示写入编号 title')
  assert.match(source, /\.dsh-ann-hl, \.dsh-ann-hl-preview \{/, '预览高亮与正式高亮共用样式')
  assert.match(source, /el\.className = className === 'preview' \? 'dsh-ann-hl-preview' : 'dsh-ann-hl'/,
    'hlAt 区分预览/正式高亮类名')
  assert.match(source, /hlAt\(previewEntry, shown, 'preview'\)/, '预览高亮用独立类名绘制')
  assert.match(source, /settleTimer = setTimeout\(function \(\) \{[\s\S]*?onSelection\(\)[\s\S]*?\}, ignoreUntil - Date\.now\(\) \+ 10\)/,
    'ignoreUntil 屏蔽期内发生的重选会延迟重评估（关闭浮窗后立即重选不丢工具条）')

  const dimToggle = sliceBetween('function toggleTagPanel(', 'function refreshTagPanel(')
  assert.match(dimToggle, /annotate\.classList\.add\('dsh-ann-ghost-dim'\)/, '展开标签时压暗「批注」按钮（二选一暗示）')
  assert.match(dimToggle, /annotate\.classList\.remove\('dsh-ann-ghost-dim'\)/, '收起标签后恢复「批注」按钮')
  assert.match(source, /\.dsh-ann-ghost-dim \{ opacity: \.42; \}/, '压暗样式存在')
  const renderActions = sliceBetween('function render()', 'function toggleTagPanel(')
  assert.match(renderActions, /if \(tagPanelOpen\) annotateBtn\.classList\.add\('dsh-ann-ghost-dim'\)/,
    '重建工具条时按展开态保持压暗')
})
