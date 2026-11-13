// 标记层裁剪路径（clip-path: polygon(evenodd, …)）的几何回归：
// polygon 只有一个轮廓，多个「洞」直接首尾相接时，洞与洞之间的连接线会额外
// 贡献射线交点，使 evenodd 环绕数在洞外区域变成偶数 —— 表现为「原文还在
// 视口里，但编号/高亮有时被整块裁掉」（issue 反馈的批注 3 滚动消失）。
// 每个洞改为「从视口上沿桥接进入、绕洞一周、原路返回」后，去回两条重合桥线
// 相互抵消，洞外区域判定重新稳定。这里用 evenodd 射线法直接驱动真实实现。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ''
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const clipWithHoles = Function(`${functionSource('clipWithHoles')}
  return clipWithHoles
`)()

const VIEW_W = 1920
const VIEW_H = 911

/** 解析 polygon(evenodd, x px, y px, …) 为顶点数组（100% 按视口宽/高分别解析）。 */
function parsePolygon(clip) {
  const body = clip.replace(/^polygon\(evenodd,/, '').replace(/\)$/, '')
  return body.split(',').map(token => {
    const parts = token.trim().replace(/px/g, '').split(/\s+/)
    assert.equal(parts.length, 2, `bad polygon token: ${token}`)
    const value = (raw, size) => (raw === '100%' ? size : Number.parseFloat(raw))
    return { x: value(parts[0], VIEW_W), y: value(parts[1], VIEW_H) }
  })
}

/** evenodd 选区判定：点向右发射水平射线，交点数为奇数即在填充区内。 */
function inside(points, x, y) {
  let count = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if ((a.y > y) === (b.y > y)) continue
    const at = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y)
    if (at > x) count++
  }
  return count % 2 === 1
}

/** 旧实现：洞与洞直接首尾相接（问题版本，仅用于回归对照）。 */
function legacyClipWithHoles(rects) {
  let d = 'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0'
  for (const r of rects) {
    d += `, ${r.left}px ${r.top}px, ${r.right}px ${r.top}px, `
      + `${r.right}px ${r.bottom}px, ${r.left}px ${r.bottom}px, ${r.left}px ${r.top}px`
  }
  return `${d})`
}

const rect = (left, top, right, bottom) => ({ left, top, right, bottom })

// 真实宿主在滚动时的遮挡区：输入区 + 会话头部 + 随滚动移动的代码块 header
// （一组实测数据：编号 (721,127) 在旧实现下就是被这组洞的连接线误裁的）。
const HEADER = rect(280, 0, 1918, 76)
const COMPOSER = rect(280, 783, 1913, 911)
const MOVING_A = rect(1050, 16, 1647, 38)
const MOVING_B = rect(901, 692, 1647, 714)
const MOVING_C = rect(901, 777, 1647, 799)
const HOLES = [COMPOSER, HEADER, MOVING_A, MOVING_B, MOVING_C]

test('single header hole: viewport content stays visible, header band is clipped', () => {
  const points = parsePolygon(clipWithHoles([HEADER]))
  assert.equal(inside(points, 721, 127), true, 'content below the header must be painted')
  assert.equal(inside(points, 721, 600), true, 'mid viewport must be painted')
  assert.equal(inside(points, 721, 40), false, 'the header band itself is a hole')
})

test('composer band is clipped in a multi-hole path', () => {
  const points = parsePolygon(clipWithHoles(HOLES))
  assert.equal(inside(points, 721, 850), false, 'input-area band is a hole')
  assert.equal(inside(points, 721, 600), true, 'content above the composer stays visible')
})

test('a passage label at 721,127 is not clipped despite nearby moving holes (regression)', () => {
  const legacy = parsePolygon(legacyClipWithHoles(HOLES))
  // 旧实现里 MOVING_A → MOVING_B 的连接线（连接两个代码块 header 洞的斜线）
  // 在 y=127 处的交点 x≈1025 > 721，使射线交点变成偶数 → (721,127) 被判成
  // 洞内并整块裁掉。这正是用户看到的「原文还在，编号却滚动消失」。
  assert.equal(inside(legacy, 721, 127), false, 'legacy path reproduces the disappearing marker')

  const fixed = parsePolygon(clipWithHoles(HOLES))
  assert.equal(inside(fixed, 721, 127), true, 'fixed path keeps the marker visible')
})

test('a passage inside a moving code-block header hole stays clipped', () => {
  const fixed = parsePolygon(clipWithHoles(HOLES))
  assert.equal(inside(fixed, 1200, 700), false, 'inside MOVING_B is still a hole')
  assert.equal(inside(fixed, 1200, 750), true, 'between moving headers is painted again')
})

test('the outer polygon is still the viewport and holes are additive', () => {
  const points = parsePolygon(clipWithHoles([]))
  assert.equal(inside(points, 5, 5), true, 'empty holes keep the whole viewport')
  // 洞的顺序不影响洞外区域（桥接保证每个洞独立抵消）
  const reordered = parsePolygon(clipWithHoles([HEADER, MOVING_C, COMPOSER, MOVING_A, MOVING_B]))
  assert.equal(inside(reordered, 721, 127), true)
})

test('holes crossing the viewport top or bottom edge keep their visible part clipped', () => {
  // 代码块 sticky header 滚到视口上方时 rect.top 为负：可见部分（0..60）仍要裁剪。
  const aboveTop = parsePolygon(clipWithHoles([rect(280, -20, 1918, 60)]))
  assert.equal(inside(aboveTop, 721, 30), false, 'the part above y=0 clamps to the viewport top')
  assert.equal(inside(aboveTop, 721, 100), true, 'content below the hole is painted')
  // 输入区在短视口里可能超出视口底部：可见部分（700..911）仍要裁剪。
  const pastBottom = parsePolygon(clipWithHoles([rect(280, 700, 1913, 1000)]))
  assert.equal(inside(pastBottom, 721, 900), false, 'the visible part of an over-tall hole is clipped')
  assert.equal(inside(pastBottom, 721, 600), true, 'content above the hole is painted')
})

test('holes crossing the viewport left or right edge stay bounded', () => {
  const crossingLeft = parsePolygon(clipWithHoles([rect(-50, 300, 100, 500)]))
  assert.equal(inside(crossingLeft, 50, 400), false, 'visible part left of x=0 clamps to the edge')
  assert.equal(inside(crossingLeft, 200, 400), true, 'content right of the hole is painted')

  const crossingRight = parsePolygon(clipWithHoles([rect(1800, 300, 2000, 500)]))
  assert.equal(inside(crossingRight, 1850, 400), false, 'visible part past the right edge is clipped')
  assert.equal(inside(crossingRight, 1700, 400), true, 'content left of the hole is painted')
})
