// Drive the actual chip positioning function with DOM geometry, including the
// queued-message dock above the input card (issue #60).
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

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height })
const CARD = rect(200, 600, 600, 150)
const SEAT = rect(180, 540, 640, 230)

function element(box, attributes = {}, parentElement = null) {
  return {
    parentElement,
    getAttribute: name => attributes[name] ?? null,
    hasAttribute: name => name in attributes,
    getBoundingClientRect: () => box,
    closest(selector) {
      for (let el = this; el !== null; el = el.parentElement) {
        if (selector === '[data-composer-seat]' && el.hasAttribute('data-composer-seat')) return el
      }
      return null
    },
  }
}

function setup({ seat = element(SEAT, { 'data-composer-seat': '' }), card = undefined, width = 1000, height = 800 } = {}) {
  let currentCard = card === undefined ? element(CARD, {}, seat) : card
  const observed = []
  let disconnects = 0
  const cleared = []
  const chipLayer = {
    style: { display: 'none' },
    textContent: '',
    appendChild() {},
    get offsetWidth() { return this.style.display === 'none' ? 0 : 102 },
    get offsetHeight() { return this.style.display === 'none' ? 0 : 24 },
  }
  const ui = { quotes: [{}, {}] }
  const document = {
    querySelector: selector => selector === '[data-composer-card]' ? currentCard : null,
    createElement: () => ({ style: {} }),
    createTextNode: text => ({ textContent: text }),
  }
  const window = { innerWidth: width, innerHeight: height }
  // updateChip 现在依赖拆分出来的 syncChipContent（内容签名缓存）、hideChip（归属
  // 清理）、composerCardEl（元素引用缓存）以及 toBottomRects（宿主「回到底部」
  // 按钮的避让矩形）。这里求值真实实现，只注入测试作用域：composerCardEl 指向
  // 可替换的 currentCard，内容缓存/几何缓存声明为块级变量（与 client.js 中同形），
  // clearTip/plural/observer 仍由测试记录。
  let toBottom = []
  const update = Function('ui', 'document', 'window', 'chipLayer', 'clearTip', 'plural', 'composerObserver', 'composerCardEl', 'toBottomRects', `
    var observedComposer = null
    var chipContentSig = null
    var chipGeom = { left: null, top: null, w: 0, h: 0 }
    ${functionSource('composerSeatOf')}
    ${functionSource('syncChipContent')}
    ${functionSource('updateChip')}
    ${functionSource('hideChip')}
    return updateChip
  `)(ui, document, window, chipLayer, owner => cleared.push(owner), () => ' annotations', {
    disconnect: () => { disconnects++ },
    observe: el => observed.push(el),
  }, () => currentCard, () => toBottom)
  return {
    ui, chipLayer, seat, window, update, observed, cleared,
    disconnects: () => disconnects,
    setCard: card => { currentCard = card },
    setToBottom: value => { toBottom = value },
    chipRect: () => rect(Number.parseFloat(chipLayer.style.left), Number.parseFloat(chipLayer.style.top), 102, 24),
  }
}

test('pending chip clears the whole queued-message dock, not just the input card (#60)', () => {
  const env = setup()
  env.update()
  assert.equal(env.chipLayer.style.display, 'flex')
  assert.ok(env.chipRect().bottom <= SEAT.top - 6, 'chip must sit above the queue and its force-submit button')
  assert.equal(env.chipRect().right, CARD.right - 12, 'horizontal alignment remains with the input card')
})

test('legacy CSS Modules composerSeat remains an anchor, and composerSeatInner is ignored', () => {
  const seat = element(SEAT, { class: 'other wSkVaW_composerSeat extra' })
  const lookalike = element(rect(200, 600, 600, 170), { class: 'wSkVaW_composerSeatInner' }, seat)
  const env = setup({ seat, card: element(CARD, {}, lookalike) })
  env.update()
  assert.ok(env.chipRect().bottom <= SEAT.top - 6)
  assert.equal(env.observed.at(-1), seat)
})

test('seat resize is observed even when adding a queue does not resize the input card', () => {
  const env = setup()
  env.update()
  assert.deepEqual(env.observed, [env.seat])
  env.update()
  assert.equal(env.disconnects(), 1, 'unchanged seat does not churn the observer')
  const nextSeat = element(rect(180, 480, 640, 290), { 'data-composer-seat': '' })
  env.setCard(element(CARD, {}, nextSeat))
  env.update()
  assert.equal(env.observed.at(-1), nextSeat)
  assert.ok(env.chipRect().bottom <= 480 - 6)
  assert.equal(env.disconnects(), 2, 'replacing the seat disconnects the old observer')
})

test('hosts without a composer seat retain the input-card fallback', () => {
  const env = setup({ seat: null })
  env.update()
  assert.equal(env.chipRect().top, CARD.top - 30)
  assert.equal(env.observed.at(-1).getBoundingClientRect(), CARD)
})

test('chip is measured on its first visible frame and stays inside a narrow viewport', () => {
  const env = setup({ seat: null, card: element(rect(30, 400, 380, 120)), width: 380, height: 600 })
  env.update()
  assert.ok(env.chipRect().left >= 8)
  assert.ok(env.chipRect().right <= 380 - 8, 'chip must not spill beyond the right viewport edge')
})

test('insufficient room above the seat hides the chip instead of covering host controls', () => {
  const env = setup({ seat: element(rect(180, 20, 640, 750), { 'data-composer-seat': '' }) })
  env.update()
  assert.equal(env.chipLayer.style.display, 'none')
  assert.equal(env.cleared.at(-1), env.chipLayer, 'the hidden chip cannot leave its hover panel behind')
  assert.equal(env.ui.quotes.length, 2, 'hiding the chip does not discard pending annotations')
  env.setCard(element(CARD, {}, element(SEAT, { 'data-composer-seat': '' })))
  env.update()
  assert.equal(env.chipLayer.style.display, 'flex', 'chip returns as soon as space is available')
})

test('a hidden or removed card hides both chip and its owned hover panel', () => {
  const env = setup()
  env.update()
  env.setCard(null)
  env.update()
  assert.equal(env.chipLayer.style.display, 'none')
  assert.equal(env.cleared.at(-1), env.chipLayer)
  assert.equal(env.disconnects(), 2)
  env.setCard(element(rect(200, 600, 0, 0)))
  env.update()
  assert.equal(env.chipLayer.style.display, 'none')
})

test('no pending annotations still clears only the pending chip panel', () => {
  const env = setup()
  env.ui.quotes = []
  env.update()
  assert.equal(env.chipLayer.style.display, 'none')
  assert.deepEqual(env.cleared, [env.chipLayer])
})

// 宿主「回到底部」按钮（class * _toBottom，34px）与待发送胶囊同在输入卡片上方
// 右侧：按钮在正文滚离底部时出现，两者会叠在一起。updateChip 必须识别按钮的
// 可见矩形并把胶囊让到它左边（用户反馈的重叠问题）。
const BOTTOM_BUTTON = rect(766, 490, 34, 34)

test('pending chip shifts left to clear the host "back to bottom" button', () => {
  const env = setup()
  env.setToBottom([BOTTOM_BUTTON])
  env.update()
  const chip = env.chipRect()
  assert.equal(chip.left, 766 - 102 - 8, 'chip leaves an 8px gap to the left of the button')
  assert.ok(chip.right <= BOTTOM_BUTTON.left, 'no horizontal overlap remains')
})

test('pending chip ignores the "back to bottom" button when they do not overlap', () => {
  const env = setup()
  env.setToBottom([rect(766, 300, 34, 34)]) // far above the chip band
  env.update()
  assert.equal(env.chipRect().left, 686)
  env.setToBottom([rect(200, 490, 34, 34)]) // far left of the chip
  env.update()
  assert.equal(env.chipRect().left, 686)
})

test('pending chip returns to the input-card right edge once the button disappears', () => {
  const env = setup()
  env.setToBottom([BOTTOM_BUTTON])
  env.update()
  assert.equal(env.chipRect().left, 656)
  env.setToBottom([])
  env.update()
  assert.equal(env.chipRect().left, 686)
})

// 真实类名启发式与缓存失效链路：宿主按钮是 `EvIC1a_toBottom`，外层还有
// `EvIC1a_toBottomSlot`（height:0 的定位容器）——只能认按钮，不能把 slot 也
// 当成避让目标；按钮挂载/卸载走 childList mutation → invalidateHostLocalRects，
// 清缓存后下一次布局必须重新查询到按钮。
function loadToBottomRects(documentMock) {
  return Function('document', 'window', `
    ${functionSource('hostLocalEls')}
    ${functionSource('hostLocalRects')}
    ${functionSource('toBottomRects')}
    return { hostLocalEls, toBottomRects }
  `)(documentMock, { innerHeight: 800 })
}

test('toBottomRects matches the host toBottom button, not its slot wrapper', () => {
  const button = {
    getAttribute: () => 'EvIC1a_toBottom',
    getBoundingClientRect: () => rect(766, 490, 34, 34),
  }
  const slot = {
    getAttribute: () => 'EvIC1a_toBottomSlot',
    getBoundingClientRect: () => rect(0, 0, 0, 0),
  }
  const api = loadToBottomRects({
    querySelectorAll: selector => selector === '[class*="_toBottom"]' ? [button, slot] : [],
  })
  assert.deepEqual(api.toBottomRects(), [rect(766, 490, 34, 34)])
})

test('toBottomRects re-queries after the host geometry cache is invalidated', () => {
  let mounted = false
  const button = {
    getAttribute: () => 'EvIC1a_toBottom',
    getBoundingClientRect: () => rect(766, 490, 34, 34),
  }
  const api = loadToBottomRects({ querySelectorAll: () => mounted ? [button] : [] })
  assert.deepEqual(api.toBottomRects(), [], 'while following the tail the host renders no button')
  mounted = true
  api.hostLocalEls.cache = null // 等价 invalidateHostLocalRects() 对 hostLocalEls 缓存的清理
  assert.deepEqual(api.toBottomRects(), [rect(766, 490, 34, 34)],
    'a mounted button is discovered after the cache is invalidated')
})


