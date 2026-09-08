import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const protocol = source.slice(source.indexOf('    var STR = {'), source.indexOf('    // ============================== 工具'))
function fn(name) {
  const match = source.match(new RegExp(`      function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n      \\}`))
  assert.ok(match, name)
  return match[0]
}
function harness(lang, draft) {
  const nodes = []
  const bubble = { querySelectorAll: () => [], get textContent() { return nodes.map(n => n.nodeValue).join('') } }
  const row = { querySelector: () => bubble }
  const shell = { state: { getSnapshot: () => ({ draft }) }, setDraft(value) { draft = value } }
  const document = { createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] ?? null } } }
  const api = Function('shell', 'document', 'NodeFilter', `
    ${protocol}
    var ui = { quotes: [{ text: '原文包含提问：这个词', note: '解释一下' }] }
    var annotationAttached = false
    var sessions = { list: { getSnapshot: () => ({ current: 'session' }) }, scope: () => ({}) }
    var ctx = { conversation: { input: { for: () => shell } } }
    function showToast() {}
    ${['buildBlock', 'shouldAttachForEnter', 'isCommandDraft', 'attachAndSend', 'hideAnnotationBlock', 'parseItemsFromBubble'].map(fn).join('\n')}
    return { setLang, attachAndSend, hideAnnotationBlock, parseItemsFromBubble }
  `)(shell, document, { SHOW_TEXT: 4 })
  api.setLang(lang)
  return { api, row, bubble, shell, render(value) {
    nodes.length = 0
    // The host may split message text across nodes.
    for (const text of [value.slice(0, 10), value.slice(10)]) nodes.push({ nodeValue: text, parentNode: { removeChild(node) { node.nodeValue = '' } } })
  } }
}

for (const lang of ['zh', 'en']) {
  test(`${lang}: 空白草稿只发送批注，刷新后仍能解析和隐藏`, () => {
    for (const draft of ['', ' \n\t ']) {
      const h = harness(lang, draft)
      assert.equal(h.api.attachAndSend({}), true)
      const sent = h.shell.state.getSnapshot().draft
      assert.doesNotMatch(sent, /(?:提问：|Ask:)\s*$/)
      assert.doesNotMatch(sent, /最后再回答我的问题|then answer my question/)
      assert.match(sent, /Annotation/)
      assert.equal(h.api.attachAndSend({}), true)
      assert.equal(h.shell.state.getSnapshot().draft, sent, '重复发送前不重复拼稿')
      h.render(sent)
      h.api.setLang(lang === 'zh' ? 'en' : 'zh')
      assert.deepEqual(h.api.parseItemsFromBubble(h.row), [{ text: '原文包含提问：这个词', note: '解释一下' }])
      assert.equal(h.api.hideAnnotationBlock(h.row), true)
      assert.equal(h.bubble.textContent, '')
    }
  })
  test(`${lang}: 有正文保留分隔标记和原始草稿，未完整渲染不误删`, () => {
    const h = harness(lang, '我的问题\n第二行')
    h.api.attachAndSend({})
    const sent = h.shell.state.getSnapshot().draft
    assert.ok(sent.endsWith((lang === 'zh' ? '提问：' : 'Ask:') + '\n我的问题\n第二行'))
    h.render(sent)
    assert.equal(h.api.hideAnnotationBlock(h.row), true)
    assert.equal(h.bubble.textContent, '我的问题\n第二行')
    h.render(lang === 'zh' ? '我批注了以下 1 处内容' : 'I annotated the following 1 passage')
    assert.equal(h.api.hideAnnotationBlock(h.row), false)
    assert.notEqual(h.bubble.textContent, '')
  })
}
