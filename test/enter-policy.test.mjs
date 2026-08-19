import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const match = source.match(/function shouldAttachForEnter\(e, draft\) \{[\s\S]*?\n      \}/)
assert.ok(match, 'client.js should define shouldAttachForEnter')
const shouldAttachForEnter = Function(`return (${match[0]})`)()

test('快捷回车只接管空草稿的纯批注', () => {
  assert.equal(shouldAttachForEnter({ ctrlKey: true, metaKey: false }, ''), true)
  assert.equal(shouldAttachForEnter({ ctrlKey: false, metaKey: true }, '  '), true)
  assert.equal(shouldAttachForEnter({ ctrlKey: true, metaKey: false }, '用户问题'), false)
  assert.equal(shouldAttachForEnter({ ctrlKey: false, metaKey: false }, '用户问题'), true)
})
