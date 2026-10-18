import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('#82: 高亮不再重播入场动画', () => {
  const style = source.slice(source.indexOf(".dsh-ann-hl {"), source.indexOf(".dsh-ann-num {"))
  assert.doesNotMatch(style, /animation/)
  assert.doesNotMatch(style, /dsh-ann-fadein/)
})

test('#82: renderMarkers 不再整层清空高亮', () => {
  const render = source.slice(source.indexOf('function renderMarkers()'), source.indexOf('function buildMarkers()'))
  assert.doesNotMatch(render, /overlay\.textContent = ''/)
})

test('#82: buildMarkers 复用 hlNodes，只改位置', () => {
  const build = source.slice(source.indexOf('function buildMarkers()'), source.indexOf('// ---------- 动作 ----------'))
  assert.match(build, /var hl = hlNodes\[hlCursor\]/)
  assert.match(build, /hl\.style\.left = rect\.left \+ 'px'/)
  assert.match(build, /hlNodes\[hx\]\.style\.display = 'none'/)
})

test('#82: 滚动时在 rAF 之前同步刷新标记', () => {
  const start = source.indexOf('function onLayoutChange()')
  const end = source.indexOf("window.addEventListener('scroll', onLayoutChange, true)", start)
  const layout = source.slice(start, end)
  const sync = layout.indexOf('renderMarkers()')
  const raf = layout.indexOf('requestAnimationFrame(')
  assert.ok(sync >= 0, '应在布局变化时刷新标记')
  assert.ok(raf > sync, 'renderMarkers 必须在 requestAnimationFrame 之前执行')
})
