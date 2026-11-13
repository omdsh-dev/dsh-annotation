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
  const ui = { quotes: [] }
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
    'clearMarkerEls', 'clearMarkers', 'renderMarkers', 'buildMarkers',
  ].map(functionSource).filter((text) => text !== '').join('\n')

  const factory = Function(
    'document', 'window', 'overlay', 'numLayer', 'ui',
    'locateQuote', 'openEditorFor', 'getComputedStyle', 'Element', 'DOMRect',
    'documentSourceOf',
    `var markerEntries = []
     var markerEntryOf = new WeakMap()
     var locateCache = new WeakMap()
     var markerHoles = null
     var markersSig = null
     var domMutationSeq = 0
     ${prelude}
     return {
       render: renderMarkers,
       entries: function () { return markerEntries },
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
