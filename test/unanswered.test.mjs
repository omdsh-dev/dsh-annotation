import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function fn(name) {
  const match = source.match(new RegExp(`      function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n      \\}`))
  assert.ok(match, name)
  return match[0]
}

function harness(lang) {
  return Function(`
    var currentLang = ${JSON.stringify(lang)}
    ${fn('listSeparator')}
    ${fn('missingIndexes')}
    ${fn('nudgeList')}
    return { missingIndexes, listSeparator, nudgeList }
  `)()
}

test('missingIndexes: 返回没有出现的编号，保持升序', () => {
  const { missingIndexes } = harness('zh')
  assert.deepEqual(missingIndexes(5, [1, 2, 4]), [3, 5])
  assert.deepEqual(missingIndexes(3, []), [1, 2, 3])
  assert.deepEqual(missingIndexes(3, [1, 2, 3]), [])
  assert.deepEqual(missingIndexes(0, []), [])
})

test('missingIndexes: 越界与重复的已覆盖编号不影响结果', () => {
  const { missingIndexes } = harness('zh')
  assert.deepEqual(missingIndexes(3, [0, 1, 1, 9]), [2, 3])
})

test('listSeparator: 中文用顿号，其他语言用逗号', () => {
  assert.equal(harness('zh').listSeparator(), '、')
  assert.equal(harness('en').listSeparator(), ', ')
  assert.equal(harness('ru').listSeparator(), ', ')
})

test('协议文案要求逐条、不合并、不跳过', () => {
  assert.ok(source.includes('不要合并或跳过'))
  assert.ok(source.includes('Do not merge or skip any'))
  assert.ok(source.includes('Не объединяйте и не пропускайте'))
})

test('nudgeList: 中文给编号，避免「第 Annotation 1 条」', () => {
  assert.equal(harness('zh').nudgeList([1]), '1')
  assert.equal(harness('zh').nudgeList([1, 3]), '1、3')
  assert.equal(harness('en').nudgeList([1, 3]), 'Annotation 1, Annotation 3')
  assert.equal(harness('ru').nudgeList([2]), 'Annotation 2')
})
