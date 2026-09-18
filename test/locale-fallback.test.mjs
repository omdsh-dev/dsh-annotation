// 语言回退：DSH 的 locale 服务不止 zh/en。节点选了第三种语言（на neural — ru）时，
// 插件只有两套文案，必须给英文，绝不能把整套界面退回中文：
// setLang 以前写成「不是 en/zh 就是 zh」，俄语节点因此看到中文批注界面。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const i18n = source.slice(source.indexOf('    var STR = {'), source.indexOf('    // ============================== 工具'))

const api = Function(`${i18n}
    return { setLang, t }
`)()

test('zh/en берутся как есть, любой другой язык — английский', () => {
  api.setLang('zh')
  assert.equal(api.t('actions.annotate'), '批注')
  api.setLang('en')
  assert.equal(api.t('actions.annotate'), 'Annotate')

  for (const other of ['ru', 'ru-RU', 'fr', 'de', 'zh-Hans']) {
    api.setLang(other)
    assert.equal(api.t('actions.annotate'), 'Annotate', `для «${other}» ожидался английский`)
    assert.equal(api.t('edit.save'), 'Save annotation')
  }
})

test('плейсхолдеры подставляются в любом языке', () => {
  api.setLang('ru')
  assert.equal(api.t('tip.title', { n: 3 }), 'Annotations (3)')
  api.setLang('zh')
  assert.equal(api.t('tip.title', { n: 3 }), '批注（3 条）')
})

test('неизвестный ключ возвращается собой', () => {
  api.setLang('ru')
  assert.equal(api.t('nope.missing'), 'nope.missing')
})
