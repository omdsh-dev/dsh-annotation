import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const match = source.match(/      function submitAttached\(\) \{[\s\S]*?\n      \}/)
assert.ok(match, 'client.js should define submitAttached')

function bench() {
  let now = 1000
  const submissions = []
  const sandbox = {
    Date: { now: () => now },
    console: { warn() {}, log() {} },
    readCurrentSessionId: () => 's1',
    sessions: { scope: () => ({}) },
    ctx: { conversation: { input: { for: () => ({ submit: mode => submissions.push(mode) }) } } },
  }
  vm.createContext(sandbox)
  vm.runInContext('var lastSubmitAt = 0\n' + match[0], sandbox)
  return {
    submissions,
    submit: () => sandbox.submitAttached(),
    advance(ms) { now += ms },
  }
}

test('#61: submitAttached 在 400ms 内只提交一次', () => {
  const b = bench()
  b.submit()
  b.advance(100)
  b.submit()
  b.advance(299)
  b.submit()
  assert.deepEqual(b.submissions, ['queue'])
})

test('#61: 400ms 后允许下一次主动发送', () => {
  const b = bench()
  b.submit()
  b.advance(400)
  b.submit()
  assert.deepEqual(b.submissions, ['queue', 'queue'])
})

test('#61: 拿不到会话/scope 时不提交，也不占用去重窗口', () => {
  let now = 1000
  const submissions = []
  const sandbox = {
    Date: { now: () => now },
    console: { warn() {}, log() {} },
    readCurrentSessionId: () => undefined,
    sessions: { scope: () => ({}) },
    ctx: { conversation: { input: { for: () => ({ submit: mode => submissions.push(mode) }) } } },
  }
  vm.createContext(sandbox)
  vm.runInContext('var lastSubmitAt = 0\n' + match[0], sandbox)
  sandbox.submitAttached()
  assert.deepEqual(submissions, [])
  now += 500
  sandbox.submitAttached()
  assert.deepEqual(submissions, [])
})
