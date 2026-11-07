import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const match = source.match(/      function queuePreviewFromText\(text\) \{[\s\S]*?\n      \}/)
assert.ok(match, 'client.js should define queuePreviewFromText')

const queuePreviewFromText = Function('blockMarkers', `
  ${match[0]}
  return queuePreviewFromText
`)(() => ['提问：', 'Ask:', 'Вопрос:'])

test('queuePreviewFromText: 中文批注块 + 提问', () => {
  const text = '我批注了以下 2 处内容（编号与原文对应），请针对它们回答我的问题：\n\n1. 第一段\n   批注：备注一\n\n2. 第二段\n   批注：备注二\n\n请按「Annotation 1：…」的格式逐条回应。\n\n提问：我的问题'
  assert.deepEqual(queuePreviewFromText(text), { count: 2, question: '我的问题' })
})

test('queuePreviewFromText: 纯批注块没有提问', () => {
  const text = '我批注了以下 1 处内容，请逐条回应：\n\n1. 原文\n   批注：备注\n\n请按「Annotation N：…」的格式逐条单独回应。'
  assert.equal(queuePreviewFromText(text).count, 1)
  assert.equal(queuePreviewFromText(text).question, '')
})

test('queuePreviewFromText: 英文 Ask 分隔符', () => {
  const text = 'I annotated the following 3 passage(s):\n\n1. a\n   Note: x\n\n2. b\n   Note: y\n\n3. c\n   Note: z\n\nAsk: what now'
  assert.deepEqual(queuePreviewFromText(text), { count: 3, question: 'what now' })
})

test('queuePreviewFromText: 换行被折叠成空格也能数对', () => {
  const text = '我批注了以下内容，请逐条回应： 1. 第一段 批注：备注一 2. 第二段 批注：备注二 请按「Annotation N：…」的格式逐条回应。'
  assert.equal(queuePreviewFromText(text).count, 2)
})

test('queuePreviewFromText: 没有编号时至少算 1 条', () => {
  assert.equal(queuePreviewFromText('我批注了以下内容\n\n提问：继续').count, 1)
})
