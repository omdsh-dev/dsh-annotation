// locateQuote 的优先级链回归：文件 → live Range → seqKey → rowHead → 全会话 → flow。
// 这里用源码切片 + 注入伪 DOM 的方式驱动真实 locateQuote，验证抽取 matchIn /
// matchNearOffset / matchAfterContext 之后控制流与评分行为不变。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

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

const body = [
  'allNormSpans', 'findNormSpan', 'ctxScore',
  'matchIn', 'matchNearOffset', 'matchAfterContext',
  'quoteVariants', 'allPositionsOf', 'locateQuote',
].map(functionSource).filter(Boolean).join('\n')

/** 简化 Range：只保留 offset/length 与 toString，供 rangeFromOffset 桩使用。 */
function makeRange (el, offset, length) {
  return {
    el,
    offset,
    length,
    toString: () => el.textContent.slice(offset, offset + length),
  }
}

function makeEl (text) {
  return { textContent: text }
}

function makeLocator () {
  const state = { anchors: {}, rows: [], flow: null }
  const document = {
    querySelector (selector) {
      const m = /^\[data-(?:chat|focus)-anchor-key="(.+)"\]$/.exec(selector)
      if (m !== null) return state.anchors[m[1]] ?? null
      if (selector === '[data-chat-flow]' || selector === '[data-focus-flow]') return state.flow
      return null
    },
    querySelectorAll () { return [] },
  }
  const rangeFromOffset = (el, offset, length) => {
    if (offset < 0 || length <= 0 || offset + length > el.textContent.length) return null
    return makeRange(el, offset, length)
  }
  const factory = Function(
    'document', 'assistantRows', 'rangeFromOffset', 'documentSourceOf',
    'DOCUMENT_TEXT', 'findRangeFlexible',
    `${body}
     return { locateQuote }`,
  )(
    document,
    () => state.rows,
    rangeFromOffset,
    () => null,
    '[data-textpreview-plain]',
    () => null,
  )
  return { state, locate: (quote, saved) => factory.locateQuote(quote, saved) }
}

const saved = (overrides) => ({
  seqKey: '', rowHead: '', textOffset: -1, ctxBefore: '', ctxAfter: '',
  ...overrides,
})

test('seqKey 锚点内：textOffset 命中优先', () => {
  const { state, locate } = makeLocator()
  const item = makeEl('hello alpha world')
  state.anchors.k1 = item
  const range = locate('alpha', saved({ seqKey: 'k1', textOffset: 6 }))
  assert.equal(range.offset, 6)
  assert.equal(range.toString(), 'alpha')
})

test('seqKey 锚点内：textOffset 失配时用 ctxBefore 续找', () => {
  const { state, locate } = makeLocator()
  const item = makeEl('x alpha y alpha z')
  state.anchors.k1 = item
  const first = locate('alpha', saved({ seqKey: 'k1', textOffset: -1, ctxBefore: 'x ' }))
  assert.equal(first.offset, 2, 'ctxBefore 指向第一次出现')
  const second = locate('alpha', saved({ seqKey: 'k1', textOffset: -1, ctxBefore: 'y ' }))
  assert.equal(second.offset, 10, 'ctxBefore 指向第二次出现')
})

test('seqKey 锚点内：重复文本按上下文评分选最佳', () => {
  const { state, locate } = makeLocator()
  state.anchors.k1 = makeEl('aa target bb target cc')
  const range = locate('target', saved({ seqKey: 'k1', ctxBefore: 'aa ', ctxAfter: ' bb' }))
  assert.equal(range.offset, 3, '应选中上下文匹配度更高的第一处')
})

test('seqKey 锚点存在但匹配不上：终止，不跨消息模糊搜索', () => {
  const { state, locate } = makeLocator()
  state.anchors.k1 = makeEl('nothing here')
  state.rows = [makeEl('missing appears in another message')]
  const range = locate('missing', saved({ seqKey: 'k1' }))
  assert.equal(range, null, 'v1.3.6 纪律：锚点消息内失败即放弃')
})

test('rowHead 前缀匹配：只在该条消息内定位', () => {
  const { state, locate } = makeLocator()
  state.rows = [
    makeEl('head-other unrelated text'),
    makeEl('head-abc quote here'),
  ]
  const range = locate('quote', saved({ rowHead: 'head-abc quote here' }))
  assert.equal(range.el.textContent, 'head-abc quote here')
  assert.equal(range.offset, 9)
})

test('全会话扫描：按上下文评分选最佳行', () => {
  const { state, locate } = makeLocator()
  state.rows = [
    makeEl('before alpha x'),
    makeEl('other alpha y'),
  ]
  const range = locate('alpha', saved({ ctxBefore: 'before ', ctxAfter: ' x' }))
  assert.equal(range.el.textContent, 'before alpha x')
  assert.equal(range.offset, 7)
})

test('没有任何匹配时返回 null', () => {
  const { state, locate } = makeLocator()
  state.rows = [makeEl('alpha beta')]
  assert.equal(locate('gamma', saved({})), null)
})

test('flow 兜底：行选择器漏掉时用空白不敏感全文匹配', () => {
  const { state, locate } = makeLocator()
  state.rows = []
  state.flow = makeEl('前面 直接写回字面量，\n代码行数也降下 后面')
  const range = locate('直接写回字面量，代码行数也降下', saved({}))
  assert.ok(range !== null)
  assert.equal(range.el, state.flow)
})
