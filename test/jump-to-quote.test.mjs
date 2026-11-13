// 输入框旁「批注 ×N」浮窗里，每条批注的原文（label tertiary）都是
// 「跳转到目标内容」入口：hover 下划线由 CSS 负责，点击把正文滚到该批注处。
// 这里驱动真实实现（从 client.js 抽取函数源码求值），只注入 DOM 几何替身，
// 覆盖滚动目标计算、clamp、窗口兜底、减少动态效果偏好与定位失败提示。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ''
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const t = key => ({
  'tip.jump': '跳转到目标内容',
  'toast.jumpLost': '未找到该批注对应的原文',
}[key] ?? key)

/** 最小元素替身：几何/滚动参数可单独设，记录 scrollTo 调用。 */
class FakeElement {
  constructor({ overflowY = 'visible', scrollTop = 0, scrollHeight = 0, clientHeight = 0, box = null } = {}) {
    this.parentElement = null
    this.overflowY = overflowY
    this.scrollTop = scrollTop
    this.scrollHeight = scrollHeight
    this.clientHeight = clientHeight
    this.box = box
    this.scrollCalls = []
  }
  getBoundingClientRect() { return this.box }
  scrollTo(options) { this.scrollCalls.push(options) }
}

const body = new FakeElement()
const documentElement = new FakeElement()
const documentMock = { body, documentElement }

function makeWindow(overrides = {}) {
  return {
    scrollY: 0,
    innerHeight: 800,
    scrollCalls: [],
    matchMedia: () => ({ matches: false }),
    scrollTo(options) { this.scrollCalls.push(options) },
    ...overrides,
  }
}

function load({ locate = () => null, toast = () => {}, win = makeWindow() } = {}) {
  const factory = Function(
    'locateQuoteCached', 'showToast', 't', 'window', 'document', 'getComputedStyle', 'Element',
    `
    ${functionSource('scrollableAncestors')}
    ${functionSource('centerRectInScroller')}
    ${functionSource('scrollRangeIntoView')}
    ${functionSource('scrollToQuote')}
    ${functionSource('enableQuoteJump')}
    return { scrollRangeIntoView, scrollToQuote, enableQuoteJump }
    `,
  )
  const getComputedStyle = el => ({ overflowY: el.overflowY })
  return factory(locate, toast, t, win, documentMock, getComputedStyle, FakeElement)
}

/** 正文里的 range：startContainer 是文本节点，挂在 leaf 元素上。 */
function rangeAt(leaf, { top = 400, height = 20 } = {}) {
  return { startContainer: { parentElement: leaf }, getBoundingClientRect: () => ({ top, height }) }
}

test('scrollRangeIntoView centers the passage in the nearest scroll container', () => {
  const win = makeWindow()
  const api = load({ win })
  const scroller = new FakeElement({
    overflowY: 'auto', scrollTop: 600, scrollHeight: 2000, clientHeight: 500,
    box: { top: 100, bottom: 600, height: 500 },
  })
  const leaf = new FakeElement()
  leaf.parentElement = scroller
  assert.equal(api.scrollRangeIntoView(rangeAt(leaf)), true)
  assert.deepEqual(scroller.scrollCalls, [{ top: 660, behavior: 'smooth' }],
    'target = scrollTop + rect.top - container.top - centering offset')
  assert.deepEqual(win.scrollCalls, [], 'a local scroller wins over the window')
})

test('scrollRangeIntoView skips non-scrollable ancestors and finds the real scrollport', () => {
  const api = load()
  const scroller = new FakeElement({
    overflowY: 'scroll', scrollTop: 0, scrollHeight: 900, clientHeight: 300,
    box: { top: 0, bottom: 300, height: 300 },
  })
  const section = new FakeElement({ overflowY: 'hidden', scrollHeight: 900, clientHeight: 300 })
  const leaf = new FakeElement()
  leaf.parentElement = section
  section.parentElement = scroller
  api.scrollRangeIntoView(rangeAt(leaf, { top: 200, height: 40 }))
  assert.deepEqual(scroller.scrollCalls, [{ top: 70, behavior: 'smooth' }])
})

test('scrollRangeIntoView clamps to the scrollable range', () => {
  const api = load()
  const scroller = new FakeElement({
    overflowY: 'auto', scrollTop: 200, scrollHeight: 1000, clientHeight: 400,
    box: { top: 0, bottom: 400, height: 400 },
  })
  const leaf = new FakeElement()
  leaf.parentElement = scroller
  api.scrollRangeIntoView(rangeAt(leaf, { top: -5000, height: 20 }))
  assert.equal(scroller.scrollCalls[0].top, 0, 'never scrolls above the content top')
  api.scrollRangeIntoView(rangeAt(leaf, { top: 9000, height: 20 }))
  assert.equal(scroller.scrollCalls[1].top, 600, 'never scrolls past the bottom')
})

test('nested scroll containers stay centered after inner scrolling moves the range', () => {
  const api = load()
  let innerScroll = 0
  let outerScroll = 0
  const outer = new FakeElement({
    overflowY: 'auto', scrollHeight: 2000, clientHeight: 500,
    box: { top: 100, bottom: 600, height: 500 },
  })
  const inner = new FakeElement({ overflowY: 'auto', scrollHeight: 1200, clientHeight: 300 })
  inner.parentElement = outer
  Object.defineProperty(inner, 'scrollTop', { get: () => innerScroll, set: value => { innerScroll = value } })
  Object.defineProperty(outer, 'scrollTop', { get: () => outerScroll, set: value => { outerScroll = value } })
  inner.scrollTo = ({ top }) => { innerScroll = top }
  outer.scrollTo = ({ top }) => { outerScroll = top }
  // 几何：inner 位于 outer 内容坐标 300 处，range 位于 inner 内容坐标 550 处；
  // range 的视口 top 会随两层 scrollTop 实时变化（真实宿主的几何语义）。
  const innerTop = () => 100 + 300 - outerScroll
  inner.getBoundingClientRect = () => ({ top: innerTop(), bottom: innerTop() + 300, height: 300 })
  const leaf = new FakeElement()
  leaf.parentElement = inner
  const range = {
    startContainer: { parentElement: leaf },
    getBoundingClientRect: () => ({ top: innerTop() + 550 - innerScroll, height: 20 }),
  }
  assert.equal(api.scrollRangeIntoView(range), true)
  assert.equal(innerScroll, 410, 'the long code block first brings the passage into its own viewport')
  assert.equal(outerScroll, 200, 'the conversation scrollport centers the post-inner-scroll position')
  const top = innerTop() + 550 - innerScroll
  assert.equal(top, 340)
  assert.equal(top + 10, 350, 'final range center equals the conversation viewport center')
})

test('scrollRangeIntoView falls back to the window when no local scroller exists', () => {
  const win = makeWindow({ scrollY: 120 })
  const api = load({ win })
  const leaf = new FakeElement()
  leaf.parentElement = body
  api.scrollRangeIntoView(rangeAt(leaf, { top: 400, height: 20 }))
  assert.deepEqual(win.scrollCalls, [{ top: 130, behavior: 'smooth' }])
})

test('scrollRangeIntoView honors prefers-reduced-motion', () => {
  const win = makeWindow({ matchMedia: () => ({ matches: true }) })
  const api = load({ win })
  const scroller = new FakeElement({
    overflowY: 'auto', scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    box: { top: 0, bottom: 400, height: 400 },
  })
  const leaf = new FakeElement()
  leaf.parentElement = scroller
  api.scrollRangeIntoView(rangeAt(leaf))
  assert.equal(scroller.scrollCalls[0].behavior, 'auto')
})

test('scrollRangeIntoView survives a host without Element.scrollTo options', () => {
  const api = load()
  const scroller = new FakeElement({
    overflowY: 'auto', scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    box: { top: 0, bottom: 400, height: 400 },
  })
  scroller.scrollTo = () => { throw new TypeError('no options overload') }
  const leaf = new FakeElement()
  leaf.parentElement = scroller
  assert.equal(api.scrollRangeIntoView(rangeAt(leaf)), true)
  assert.equal(scroller.scrollTop, 210, 'falls back to assigning scrollTop')
})

test('scrollToQuote reports a lost passage instead of scrolling nowhere', () => {
  const toasts = []
  const api = load({ locate: () => null, toast: message => toasts.push(message) })
  assert.equal(api.scrollToQuote({ id: 'q1', text: 'gone' }), false)
  assert.deepEqual(toasts, ['未找到该批注对应的原文'])
})

test('scrollToQuote scrolls to the located range', () => {
  const seen = []
  const win = makeWindow()
  const api = load({
    win,
    locate: q => { seen.push(q); return rangeAt(new FakeElement(), { top: 400, height: 20 }) },
  })
  const q = { id: 'q2', text: 'passage' }
  assert.equal(api.scrollToQuote(q), true)
  assert.equal(seen[0], q)
  assert.deepEqual(win.scrollCalls, [{ top: 10, behavior: 'smooth' }])
})

test('scrollToQuote reports a failure when the located range cannot be scrolled', () => {
  const toasts = []
  const api = load({ locate: () => ({ startContainer: null }), toast: message => toasts.push(message) })
  assert.equal(api.scrollToQuote({ id: 'q4', text: 'detached' }), false)
  assert.deepEqual(toasts, ['未找到该批注对应的原文'])
})

test('enableQuoteJump marks the label, sets the hover hint and jumps on click', () => {
  const jumped = []
  const api = load({ locate: q => { jumped.push(q); return rangeAt(new FakeElement()) } })
  const listeners = {}
  const label = {
    classList: { tokens: [], add(token) { this.tokens.push(token) } },
    title: '',
    addEventListener(type, fn) { listeners[type] = fn },
  }
  const q = { id: 'q3', text: 'clicked passage' }
  api.enableQuoteJump(label, q)
  assert.deepEqual(label.classList.tokens, ['dsh-ann-tip-jump'])
  assert.equal(label.title, '跳转到目标内容')
  let stopped = 0
  listeners.click({ stopPropagation: () => { stopped++ } })
  assert.equal(stopped, 1, 'the float panel must not treat this as an outside click')
  assert.equal(jumped[0], q)
})

test('the chip tip passage label is wired to enableQuoteJump', () => {
  assert.match(functionSource('showChipTip'), /enableQuoteJump\(body, q\)/)
})

test('the jump CSS adds an underline on hover only', () => {
  assert.match(source, /\.dsh-ann-tip-jump \{ cursor: pointer; \}/)
  assert.match(source, /\.dsh-ann-tip-jump:hover \{ text-decoration: underline; text-underline-offset: 2px; \}/)
})

test('zh/en/ru all carry the jump hint and lost-passage toast', () => {
  const i18n = source.slice(source.indexOf('    var STR = {'), source.indexOf('    // ============================== 工具'))
  const api = Function(`${i18n}
    return { setLang, t }
  `)()
  for (const lang of ['zh', 'en', 'ru']) {
    api.setLang(lang)
    assert.equal(typeof api.t('tip.jump'), 'string')
    assert.notEqual(api.t('tip.jump'), 'tip.jump')
    assert.notEqual(api.t('tip.jump'), '')
    assert.equal(typeof api.t('toast.jumpLost'), 'string')
    assert.notEqual(api.t('toast.jumpLost'), 'toast.jumpLost')
  }
})
