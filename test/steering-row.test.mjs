import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('插队/steering 消息也会隐藏批注块', () => {
  const decorate = source.slice(source.indexOf('function decorateAll()'), source.indexOf('var decoTimer'))
  assert.match(decorate, /isAssistantRow\(el\) \|\| isFocusAssistantRow\(el\)/, '助手行不参与气泡装饰')
  assert.match(decorate, /querySelector\('\[class\*="bubble"\]'\) \|\| el/, '没有 bubble class 时退回整行')
  assert.doesNotMatch(decorate, /if \(b === null \|\| !hasAnnotationBlock/, '不能因为拿不到 bubble 就跳过')
})

test('pending steering echo 也会被单独扫描', () => {
  assert.match(source, /querySelectorAll\('\[data-pending-steering\]'\)/)
  assert.match(source, /attachBubbleTag\(pe, pitems\)/)
})

test('插入带批注块的新节点时同步装饰，避免先闪原文', () => {
  assert.match(source, /hasAnnotationInsert = true/)
  assert.match(source, /if \(hasAnnotationInsert\) \{[\s\S]{0,400}decorateAll\(\)/)
  assert.match(source, /hasAnnotationBlock\(node\.textContent \|\| ''\)/)
})

test('hideAnnotationBlock / parseItemsFromBubble 对无 bubble 行有回退', () => {
  assert.match(source, /var bubble = row\.querySelector\('\[class\*="bubble"\]'\) \|\| row/)
  assert.match(source, /var b = row\.querySelector\('\[class\*="bubble"\]'\) \|\| row/)
})
