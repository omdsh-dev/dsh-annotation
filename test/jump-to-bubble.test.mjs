// 气泡浮窗与回复芯片浮窗的原文跳转：
// - 用户消息气泡上的「批注 ×N」浮窗、助手回复里的「Annotation N」芯片浮窗，
//   点原文都跳回正文里被批注的那段文本，并高亮 2 秒作为视线落点；
// - items 保持 `{ text, note }` 原格式，直接把 item 交给 enableQuoteJump。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('气泡浮窗与回复芯片浮窗的原文都能跳回正文文本', () => {
  assert.match(source, /enableQuoteJump\(body, list\[i\], true\)/, '气泡浮窗原文可点击并高亮')
  assert.match(source, /enableQuoteJump\(quote, item, true\)/, '回复芯片浮窗原文可点击并高亮')
  assert.match(source, /return \{ text: quoteWithSource\(q\), note: q\.note \|\| '' \}/, '保持原 items 格式')
  assert.doesNotMatch(source, /itemAnchor|enableItemJump|scrollToRow|enableRowJump|__row/,
    '不再额外解析或跳到用户消息')
  assert.match(source, /\.dsh-ann-tip-jump \{ cursor: pointer; \}/, '复用 hover 下划线样式')
})

test('跳转后用 CSS Highlight 把目标文本高亮 2 秒', () => {
  assert.match(source, /function flashRange\(range\)/)
  assert.match(source, /CSS\.highlights\.set\('dsh-ann-jump-flash', new Highlight\(range\)\)/)
  assert.match(source, /setTimeout\(function \(\) \{[\s\S]*?2000/, '2 秒后清除高亮')
  assert.match(source, /CSS\.highlights\.delete\('dsh-ann-jump-flash'\)/)
  assert.match(source, /::highlight\(dsh-ann-jump-flash\)/, '高亮样式')
})
