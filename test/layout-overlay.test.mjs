import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('设置弹窗打开时隐藏会话高亮层（issue #44）', () => {
  assert.match(source, /body:has\(\[role="dialog"\]\[aria-modal="true"\]\) \[data-annotation-overlay\] \{ display: none; \}/)
})

test('滚动和布局变化会刷新输入框批注胶囊（issue #44）', () => {
  const start = source.indexOf('function onLayoutChange()')
  const end = source.indexOf("window.addEventListener('scroll', onLayoutChange, true)", start)
  assert.ok(start >= 0 && end > start, 'client.js should define the shared layout refresh')
  assert.match(source.slice(start, end), /updateChip\(\)/)
  assert.match(source, /new ResizeObserver\(onLayoutChange\)/)
  assert.match(source, /composerObserver\.disconnect\(\)/)
})
