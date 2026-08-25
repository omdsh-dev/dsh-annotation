import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf("    var PENDING_STORAGE_PREFIX = 'dsh.annotation.pending.v1.'")
const end = source.indexOf('    // ============================== 插件主体', start)
assert.ok(start >= 0 && end > start, 'pending storage helpers must exist')

const helpers = Function(`${source.slice(start, end)}; return { pendingStorageKey, parsePendingQuotes, stringifyPendingQuotes }`)()

test('pending annotations round-trip per session without serializing live DOM ranges', () => {
  const raw = helpers.stringifyPendingQuotes([{
    id: 'q-1', text: '原文', note: '批注', range: { unsafe: true },
    seqKey: 'session/1', rowHead: '开头', textOffset: 4, ctxBefore: '前', ctxAfter: '后',
  }])
  const restored = helpers.parsePendingQuotes(raw)

  assert.equal(helpers.pendingStorageKey('会话/1'), 'dsh.annotation.pending.v1.%E4%BC%9A%E8%AF%9D%2F1')
  assert.deepEqual(restored, [{
    id: 'q-1', text: '原文', note: '批注', range: null,
    seqKey: 'session/1', rowHead: '开头', textOffset: 4, ctxBefore: '前', ctxAfter: '后',
  }])
  assert.deepEqual(helpers.parsePendingQuotes('{broken'), [])
})
