import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const match = source.match(/function shouldAttachForEnter\(e, draft\) \{[\s\S]*?\n      \}/)
assert.ok(match, 'client.js should define shouldAttachForEnter')
const shouldAttachForEnter = Function(`return (${match[0]})`)()

const cmdMatch = source.match(/function isCommandDraft\(draft\) \{[\s\S]*?\n      \}/)
assert.ok(cmdMatch, 'client.js should define isCommandDraft')
const isCommandDraft = Function(`return (${cmdMatch[0]})`)()

test('快捷回车只接管空草稿的纯批注', () => {
  assert.equal(shouldAttachForEnter({ ctrlKey: true, metaKey: false }, ''), true)
  assert.equal(shouldAttachForEnter({ ctrlKey: false, metaKey: true }, '  '), true)
  assert.equal(shouldAttachForEnter({ ctrlKey: true, metaKey: false }, '用户问题'), false)
  assert.equal(shouldAttachForEnter({ ctrlKey: false, metaKey: false }, '用户问题'), true)
})

test('斜杠命令草稿不拼批注，命令原样放行（issue #20）', () => {
  assert.equal(isCommandDraft('/goal 完成实验'), true)
  assert.equal(isCommandDraft('  /model sonnet'), true)
  assert.equal(isCommandDraft('用户问题'), false)
  assert.equal(isCommandDraft(''), false)
  assert.equal(isCommandDraft('路径 /usr/bin 不是命令'), false)
})

test('attachAndSend 在 setDraft 之前拦截命令草稿', () => {
  const fn = source.match(/function attachAndSend\(e\) \{[\s\S]*?\n      \}/)
  assert.ok(fn, 'client.js should define attachAndSend')
  const guard = fn[0].indexOf('isCommandDraft')
  const splice = fn[0].indexOf('setDraft')
  assert.ok(guard !== -1, 'attachAndSend should guard with isCommandDraft')
  assert.ok(splice !== -1, 'attachAndSend should call setDraft')
  assert.ok(guard < splice, 'command guard must run before setDraft splices the block')
})

test('新版可编辑输入区按 Enter 会进入批注拼稿（issue #41）', () => {
  const fn = source.match(/function onKeyDown\(e\) \{[\s\S]*?\n      \}/)
  assert.ok(fn, 'client.js should define onKeyDown')
  assert.match(fn[0], /closest\('\[data-composer-input\]'\)/)
  assert.doesNotMatch(fn[0], /HTMLTextAreaElement/)
})

test('保存批注后聚焦新版输入区，并把光标放在草稿末尾', () => {
  const fn = source.match(/function focusComposer\(\) \{[\s\S]*?\n      \}/)
  assert.ok(fn, 'client.js should define focusComposer')
  const calls = []
  class HTMLElement {}
  const input = Object.assign(new HTMLElement(), {
    isContentEditable: true, isConnected: true,
    focus: options => calls.push(['focus', options]),
  })
  const selection = {
    selectAllChildren: element => calls.push(['select', element]),
    collapseToEnd: () => calls.push(['end']),
  }
  const focusComposer = Function('document', 'window', 'HTMLElement', 'HTMLTextAreaElement', 'requestAnimationFrame',
    `return (${fn[0]})`)(
    { querySelector: selector => selector === '[data-composer-card] [data-composer-input]' ? input : null },
    { getSelection: () => selection }, HTMLElement, class HTMLTextAreaElement {}, callback => callback(),
  )
  focusComposer()
  assert.deepEqual(calls, [['focus', { preventScroll: true }], ['select', input], ['end']])
  calls.length = 0
  input.isConnected = false
  focusComposer()
  assert.deepEqual(calls, [])
})

test('发送按钮在 pointerdown 阶段先拼稿，空草稿按钮则由插件直接提交', () => {
  const fn = source.match(/function onSendPointerDown\(e\) \{[\s\S]*?\n      \}/)
  assert.ok(fn, 'client.js should define onSendPointerDown')
  assert.match(fn[0], /sendButtonOf\(e\.target\)/)
  assert.match(fn[0], /attachAndSend\(\{ ctrlKey: false, metaKey: false \}\)/)
  assert.match(fn[0], /!wasDisabled\) return/)
  assert.match(fn[0], /submitAttached\(\)/)
})

test('丢失 compositionend 的输入法锁会超时复位', () => {
  const fn = source.match(/function isImeKeyBlocked\(e\) \{[\s\S]*?\n      \}/)
  assert.ok(fn, 'client.js should define isImeKeyBlocked')
  assert.match(fn[0], /imeClearTimer === null/)
  assert.match(fn[0], /Date\.now\(\) - imeTouchedAt >= 1200/)
  assert.match(fn[0], /imeComposing = false/)
})
