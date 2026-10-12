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
function harness(lang, draft, sourcePath, sessionsOverride, storageOverride) {
  const nodes = []
  const bubble = { querySelectorAll: () => [], get textContent() { return nodes.map(n => n.nodeValue).join('') } }
  const row = { querySelector: () => bubble }
  const shell = { state: { getSnapshot: () => ({ draft }) }, setDraft(value) { draft = value } }
  const document = { createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] ?? null } } }
  const sessions = sessionsOverride ?? {
    list: { getSnapshot: () => ({ current: 'session' }) },
    scope: () => ({}),
  }
  const api = Function('shell', 'document', 'NodeFilter', 'sourcePath', 'sessions', 'localStorage', `
    ${protocol}
    ${source.slice(source.indexOf('    function quoteWithSource('), source.indexOf('    function assistantRows('))}
    var ui = { quotes: [{ text: '原文包含提问：这个词', note: '解释一下' }] }
    ui.quotes[0].sourcePath = sourcePath
    var annotationAttached = false
    var ctx = { conversation: { input: { for: () => shell } } }
    var uiSessionService = null
    function showToast() {}
    ${['uiSessionFace', 'currentSessionSource', 'readCurrentSessionId'].map(fn).join('\n')}
    ${['buildBlock', 'shouldAttachForEnter', 'isCommandDraft', 'attachAndSend', 'hideAnnotationBlock', 'parseItemsFromBubble'].map(fn).join('\n')}
    return {
      setLang,
      attachAndSend,
      hideAnnotationBlock,
      parseItemsFromBubble,
      storedAnnotationMessage,
      visibleAnnotationLabels,
      annotationSearchProjection,
    }
  `)(shell, document, { SHOW_TEXT: 4 }, sourcePath, sessions, storageOverride)
  api.setLang(lang)
  return { api, row, bubble, shell, render(value) {
    nodes.length = 0
    // The host may split message text across nodes.
    for (const text of [value.slice(0, 10), value.slice(10)]) nodes.push({ nodeValue: text, parentNode: { removeChild(node) { node.nodeValue = '' } } })
  } }
}

/** Языковая таблица: разделитель вопроса, инструкция с вопросом, заголовок блока. */
const LANGS = {
  zh: { marker: '提问：', withQuestion: /最后再回答我的问题/, head: '我批注了以下 1 处内容', other: 'en' },
  en: { marker: 'Ask:', withQuestion: /then answer my question/, head: 'I annotated the following 1 passage', other: 'zh' },
  ru: { marker: 'Вопрос:', withQuestion: /затем ответьте на мой вопрос/, head: 'Я аннотировал следующие', other: 'zh' },
}

for (const lang of Object.keys(LANGS)) {
  const L = LANGS[lang]
  test(`${lang}: 空白草稿只发送批注，刷新后仍能解析和隐藏`, () => {
    for (const draft of ['', ' \n\t ']) {
      const h = harness(lang, draft)
      assert.equal(h.api.attachAndSend({}), true)
      const sent = h.shell.state.getSnapshot().draft
      assert.doesNotMatch(sent, /(?:提问：|Ask:|Вопрос:)\s*$/)
      assert.doesNotMatch(sent, L.withQuestion)
      assert.match(sent, /Annotation/)
      assert.equal(h.api.attachAndSend({}), true)
      assert.equal(h.shell.state.getSnapshot().draft, sent, '重复发送前不重复拼稿')
      h.render(sent)
      h.api.setLang(L.other)
      assert.deepEqual(h.api.parseItemsFromBubble(h.row), [{ text: '原文包含提问：这个词', note: '解释一下' }])
      assert.equal(h.api.hideAnnotationBlock(h.row), true)
      assert.equal(h.bubble.textContent, '')
    }
  })
  test(`${lang}: 有正文保留分隔标记和原始草稿，未完整渲染不误删`, () => {
    const h = harness(lang, '我的问题\n第二行')
    h.api.attachAndSend({})
    const sent = h.shell.state.getSnapshot().draft
    assert.ok(sent.endsWith(L.marker + '\n我的问题\n第二行'))
    h.render(sent)
    assert.equal(h.api.hideAnnotationBlock(h.row), true)
    assert.equal(h.bubble.textContent, '我的问题\n第二行')
    h.render(L.head)
    assert.equal(h.api.hideAnnotationBlock(h.row), false)
    assert.notEqual(h.bubble.textContent, '')
  })
}

for (const lang of ['zh', 'en']) {
  test(`${lang}: 文件路径随批注发送，刷新后的标签仍含完整路径`, () => {
    const h = harness(lang, '', '文档/结果 #1.md')
    assert.equal(h.api.attachAndSend({}), true)
    const sent = h.shell.state.getSnapshot().draft
    assert.ok(sent.includes('[文档/结果 #1.md]\n   原文包含提问：这个词'))
    h.render(sent)
    assert.equal(h.api.parseItemsFromBubble(h.row)[0].text, '[文档/结果 #1.md]\n原文包含提问：这个词')
    assert.equal(h.api.hideAnnotationBlock(h.row), true)
  })
}

test('完整批注消息只把用户真正输入的问题交给搜索', () => {
  const h = harness('zh', '这是用户真正输入的问题')
  assert.equal(h.api.attachAndSend({}), true)
  const stored = h.shell.state.getSnapshot().draft
  assert.deepEqual(h.api.storedAnnotationMessage(stored), {
    count: 1,
    question: '这是用户真正输入的问题',
  })
})

test('纯批注消息不会把自动生成的协议文字交给搜索', () => {
  const h = harness('zh', '')
  assert.equal(h.api.attachAndSend({}), true)
  const stored = h.shell.state.getSnapshot().draft
  assert.deepEqual(h.api.storedAnnotationMessage(stored), { count: 1, question: '' })
})

test('看起来相似的普通用户文字不会被误删', () => {
  const h = harness('zh', '')
  assert.equal(h.api.storedAnnotationMessage('我批注了以下内容，但这只是普通文字。'), null)
})

test('助手记录里的批注标题与页面芯片文字保持一致', () => {
  const h = harness('zh', '')
  assert.equal(
    h.api.visibleAnnotationLabels('Annotation 1：第一条\nAnnotation 2: 第二条\nAnnotation 3：保留', 2),
    'Annotation 1第一条\nAnnotation 2 第二条\nAnnotation 3：保留',
  )
})

test('普通用户消息会结束上一轮批注标题的搜索转换', () => {
  const h = harness('zh', '这是用户真正输入的问题')
  assert.equal(h.api.attachAndSend({}), true)
  const project = h.api.annotationSearchProjection()
  const annotated = h.shell.state.getSnapshot().draft
  assert.deepEqual(project({ kind: 'user', sourceKind: 'user', raw: annotated }), {
    storedRaw: annotated,
    raw: '这是用户真正输入的问题',
  })
  assert.deepEqual(project({ kind: 'assistant', format: 'markdown', raw: 'Annotation 1：回答' }), {
    storedRaw: 'Annotation 1：回答',
    raw: 'Annotation 1回答',
  })
  assert.equal(project({ kind: 'user', sourceKind: 'user', raw: '下一条普通消息' }), null)
  assert.equal(project({ kind: 'assistant', format: 'markdown', raw: 'Annotation 1：普通正文' }), null)
})

test('搜索兼容保持可选，并使用上游包名登记', () => {
  assert.match(source, /ctx\.inject\(\['ryuu\.findAllSearchContent'\]/)
  assert.match(source, /searchContent\.register\('@changfenhuang\/dsh-annotation'/)
  assert.doesNotMatch(source, /searchContent\.register\('@ryuu-64\/dsh-annotation'/)
  assert.match(source, /data-find-projection-chrome/)
})

// issue #64：DSH 0.1.6-alpha.2 移除了 sessions.list.current。已发布宿主上
// `sessions.currentProvideInfo` 并不存在（上游契约已无此成员），真实可用路径是
// ① localStorage['dsh.sessions.current'] ② 旧 list.current ③ list 行 retainedBy.mainView。
const newKernelList = (rows, ids) => ({
  list: { getSnapshot: () => ({ ids: ids ?? Object.keys(rows), byId: rows, phase: 'ready' }) },
  scope: (id) => (Object.prototype.hasOwnProperty.call(rows, id) ? {} : undefined),
})
for (const lang of ['zh', 'en']) {
  test(`${lang}: 新内核形状（list 无 current）+ 持久化选择态下批注仍随消息发送（issue #64）`, () => {
    const kernel = newKernelList({ 'session-a': { retainedBy: {} } })
    const storage = { getItem: (k) => (k === 'dsh.sessions.current' ? JSON.stringify({ sessionId: 'session-a' }) : null) }
    const h = harness(lang, '我的问题', undefined, kernel, storage)
    assert.equal(h.api.attachAndSend({}), true)
    assert.match(h.shell.state.getSnapshot().draft, /Annotation/)
  })

  test(`${lang}: 无持久化键时退回 retainedBy.mainView 公开面`, () => {
    const kernel = newKernelList({ 'session-b': { retainedBy: { mainView: 1 } } })
    const h = harness(lang, '我的问题', undefined, kernel)
    assert.equal(h.api.attachAndSend({}), true)
    assert.match(h.shell.state.getSnapshot().draft, /Annotation/)
  })

  test(`${lang}: 旧内核形状（仅 list.current）下保持兼容`, () => {
    const legacySessions = {
      list: { getSnapshot: () => ({ current: 'session' }) },
      scope: () => ({}),
    }
    const h = harness(lang, '', undefined, legacySessions)
    assert.equal(h.api.attachAndSend({}), true)
    assert.match(h.shell.state.getSnapshot().draft, /Annotation/)
  })
}
