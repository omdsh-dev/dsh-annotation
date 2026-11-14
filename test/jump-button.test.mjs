// 「回到批注内容」箭头：
// - 工具条只在停靠上/下沿时显示；编辑框只在原文被裁剪/滚出视口时显示；
// - clampBarTop 把工具条挡在输入区/会话头部朝向正文的一侧；
// - jumpGap / jumpDirection / jumpPlacement 决定箭头是否出现、位置与方向；
// - 箭头是透明双 V，独立于 host。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function functionSource (name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ''
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const helpers = Function(
  `${['clampBarTop', 'jumpGap', 'jumpDirection', 'jumpPlacement'].map(functionSource).join('\n')}
   return { clampBarTop, jumpGap, jumpDirection, jumpPlacement }`,
)()

const rect = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height,
})

test('clampBarTop：无重叠时只做视口约束', () => {
  assert.equal(helpers.clampBarTop(rect(100, 100, 80, 30), [], 800), 100)
  assert.equal(helpers.clampBarTop(rect(100, 0, 80, 30), [], 800), 8)
  assert.equal(helpers.clampBarTop(rect(100, 790, 80, 30), [], 800), 762)
})

test('clampBarTop：停在输入区朝向正文的一侧（上沿外）', () => {
  const composer = rect(0, 600, 1000, 100)
  assert.equal(helpers.clampBarTop(rect(100, 580, 80, 30), [composer], 800), 562,
    '工具条底边停在输入区上沿外 8px：600 - 30 - 8')
  assert.equal(helpers.clampBarTop(rect(100, 650, 80, 30), [composer], 800), 562,
    '即使工具条已经落进输入区偏下的位置，也要被推回输入区上方')
})

test('clampBarTop：停在头部朝向正文的一侧（下沿外）', () => {
  const header = rect(0, 0, 1000, 64)
  const top = helpers.clampBarTop(rect(100, 20, 80, 30), [header], 800)
  assert.equal(top, 72, '工具条顶边停在头部下沿外 8px：64 + 8')
})

test('clampBarTop：水平不相交时保持原位', () => {
  const composer = rect(0, 600, 50, 100)
  assert.equal(helpers.clampBarTop(rect(100, 580, 80, 30), [composer], 800), 580)
})

test('jumpGap：目标在上/下取边到边距离，重叠为 0', () => {
  const anchor = rect(100, 200, 100, 30)
  assert.equal(helpers.jumpGap(rect(100, 100, 80, 20), anchor), 80)
  assert.equal(helpers.jumpGap(rect(100, 400, 80, 20), anchor), 170)
  assert.equal(helpers.jumpGap(rect(100, 210, 80, 20), anchor), 0)
  assert.equal(helpers.jumpGap(null, anchor), -1)
})

test('jumpDirection：按目标中心相对浮窗中心决定箭头方向', () => {
  const anchor = rect(100, 200, 100, 30)
  assert.equal(helpers.jumpDirection(rect(100, 100, 80, 20), anchor), 'up')
  assert.equal(helpers.jumpDirection(rect(100, 400, 80, 20), anchor), 'down')
})

test('jumpPlacement：上沿停靠→浮窗下方+向上箭头；下沿停靠→浮窗上方+向下箭头', () => {
  const anchor = rect(100, 200, 100, 30)
  assert.deepEqual(helpers.jumpPlacement('top', 'down', anchor), { dir: 'up', top: 234 })
  assert.deepEqual(helpers.jumpPlacement('bottom', 'up', anchor), { dir: 'down', top: 168 })
  assert.deepEqual(helpers.jumpPlacement('', 'up', anchor), { dir: 'up', top: 168 })
  assert.deepEqual(helpers.jumpPlacement('', 'down', anchor), { dir: 'down', top: 234 })
})

test('源码守卫：停靠上下沿才显示箭头；双 V 动画与编辑框条件', () => {
  assert.match(source, /function clampBarTop\(rect, holes, viewportHeight\)/)
  assert.match(source, /function applyBarClamp\(bar\)/)
  assert.match(source, /hostLocalRects\('composerStack'\)/, '输入区遮挡优先用无缝的 composerStack')
  assert.match(source, /hostLocalRects\('composerSeat'\)/, 'composerStack 缺失时回退 composerSeat')
  assert.match(source, /var composers = hostComposerRects\(\)/, '输入区几何直接来自 composerStack')
  assert.match(source, /top = Math\.min\(top, c\.top - rect\.height - 8\)/, '输入区上沿是工具条硬上限')
  assert.match(source, /top = Math\.max\(top, viewRect\.top \+ 8\)/, '正文滚动区上沿作为兜底下限')
  assert.match(source, /function jumpPlacement\(edge, dir, anchor\)/)
  assert.match(source, /function jumpEdge\(anchor\)/)
  assert.match(source, /var edge = ui\.mode === 'actions' \? jumpEdge\(anchor\) : ''/, '只在工具条停靠时应用内侧箭头')
  assert.match(source, /if \(ui\.mode === 'actions' && edge === ''\) \{ hideJumpButton\(\); return \}/,
    '工具条未停靠上下沿时不显示箭头')
  assert.match(source, /Math\.abs\(anchor\.top - \(viewRect\.top \+ 8\)\) <= 2/, '识别上沿停靠')
  assert.match(source, /Math\.abs\(anchor\.bottom - \(composers\[i\]\.top - 8\)\) <= 2/, '识别下沿停靠')
  assert.match(source, /var below = h\.top \+ h\.height \/ 2 > viewportHeight \/ 2/, '按遮挡区在视口上下半部决定朝向')
  assert.match(source, /top = below \? h\.top - height - 8 : h\.bottom \+ 8/, '工具条停在遮挡区朝向正文的一侧')
  assert.doesNotMatch(source, /clipBarToHoles|barClipPath|__annClip/, '工具条不再使用 clip-path 裁剪')

  assert.match(source, /anchor\.top - 32/, '原文在上方时箭头在浮窗上沿（间距 4px）')
  assert.match(source, /anchor\.bottom \+ 4/, '原文在下方时箭头在浮窗下沿（间距 4px）')
  assert.doesNotMatch(source, /jumpButtonTop/, '箭头不按洞口边沿单独定位')
  assert.match(source, /width: 44px; height: 28px/, '箭头改为扁长方形')
  assert.match(source, /background: transparent/, '去掉按钮底板，只保留双 V')
  assert.match(source, /border: 0; background: transparent/, '无边框无背景')
  assert.match(source, /var left = centerX - 22/, '箭头水平中心严格对齐浮窗中轴')
  assert.match(source, /function trackBarWidth\(\)/, '标签面板展开/收起时持续跟随宽度')
  assert.match(source, /trackBarWidth\(\)/, '展开/收起后启动宽度跟随')
  assert.match(source, /dsh-ann-jump-up/, '向上时使用向上双 V')
  assert.match(source, /dsh-ann-jump-down/, '向下时使用向下双 V')
  assert.match(source, /dsh-ann-chev-down/, '双 V 向下循环动画')
  assert.match(source, /dsh-ann-chev-up/, '双 V 向上循环动画')
  assert.match(source, /M8 8\.8L1\.6 2\.4/, '向下双 V 加宽')
  assert.match(source, /M8 7\.2L1\.6 13\.6/, '向上双 V 加宽')
  assert.doesNotMatch(source, /dsh-ann-jump-below|dsh-ann-jump-above/, '不再使用贴合胶囊样式')
  assert.match(source, /document\.body\.appendChild\(btn\)/, '箭头挂在 body，避免 render 清空 host 时被删')
  assert.match(source, /scrollRangeIntoView\(range\)/, '点击后复用现有的滚动定位')
  assert.match(source, /function positionEditor\(card, left, top\)[\s\S]*?updateJumpButton\(\)/,
    '拖动编辑框时箭头跟随移动')
  assert.match(source, /if \(ui\.mode === 'editing'\) \{[\s\S]*?if \(!offscreen && !blocked\)/,
    '编辑框内原文未裁剪时不显示箭头')
  assert.match(source, /var JUMP_GAP = 48/)

  const observer = source.slice(
    source.indexOf('function mutationRelevant('),
    source.indexOf('function mutationRelevant(') + 900,
  )
  assert.match(observer, /data-annotation-jump/, '箭头自身更新不能触发插件 MutationObserver')

  const outside = source.slice(
    source.indexOf('function onDocPointerDown('),
    source.indexOf('function onDocPointerDown(') + 400,
  )
  assert.match(outside, /data-annotation-jump/, '点击箭头不能按「点外部」关闭工具条')
})
