import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('#81: 空的 overlay / numLayer 默认不参与命中测试', () => {
  assert.match(source, /data-annotation-overlay[\s\S]{0,600}display:none/)
  assert.match(source, /data-annotation-num-layer[\s\S]{0,600}display:none/)
})

test('#81: 层本体 visibility:hidden，只有高亮/编号可见', () => {
  assert.match(source, /data-annotation-overlay[\s\S]{0,600}visibility:hidden/)
  assert.match(source, /data-annotation-num-layer[\s\S]{0,600}visibility:hidden/)
  assert.match(source, /\.dsh-ann-hl \{[^}]*visibility: visible/)
  assert.match(source, /\.dsh-ann-num \{[^}]*visibility: visible/)
})

test('#81: renderMarkers 按可见标记数量切回 display', () => {
  assert.match(source, /overlay\.style\.display = visibleHl > 0 \? '' : 'none'/)
  assert.match(source, /numLayer\.style\.display = visibleNum > 0 \? '' : 'none'/)
})
