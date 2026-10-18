import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const match = source.match(/      function findPrevAnnotationItems\(row\) \{[\s\S]*?\n      \}/)
assert.ok(match, 'client.js should define findPrevAnnotationItems')

function makeRow(kind, items) {
  return {
    kind,
    getAttribute(name) { return name === 'data-chat-flow-kind' ? kind : null },
    querySelector(selector) {
      if (selector === '[data-annotation-bubble-tag]') {
        return items === undefined ? null : { __annotationItems: items }
      }
      if (selector === '[class*="bubble"]') return kind === 'user' || kind === 'steering' ? {} : null
      return null
    },
  }
}

function run(rows, index) {
  const api = Function('allMessageRows', `
    ${match[0]}
    return findPrevAnnotationItems
  `)(() => rows)
  return api(rows[index])
}

test('只继承紧邻的上一条用户消息', () => {
  const items = [{ text: 'a', note: 'b' }]
  const user1 = makeRow('user', items)
  const assistant1 = makeRow('assistant-step')
  const user2 = makeRow('user')
  const assistant2 = makeRow('assistant-step')
  const rows = [user1, assistant1, user2, assistant2]

  assert.deepEqual(run(rows, 1), items)
  // 普通消息后的回复不能继承上上一条消息的批注
  assert.equal(run(rows, 3), null)
})

test('插队/steering 消息的批注会被继承', () => {
  const items = [{ text: 'x', note: 'y' }]
  const steering = makeRow('steering', items)
  const assistant = makeRow('assistant-step')
  assert.deepEqual(run([steering, assistant], 1), items)
})

test('遇到用户行没有标签时立即停止，不再往前找', () => {
  const user1 = makeRow('user', [{ text: 'old', note: '' }])
  const assistant1 = makeRow('assistant-step')
  const user2 = makeRow('user')
  const assistant2 = makeRow('assistant-step')
  assert.equal(run([user1, assistant1, user2, assistant2], 3), null)
})
