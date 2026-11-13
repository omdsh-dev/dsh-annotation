// host half（lib/index.js）的标签持久化与 /annotation-tags 路由测试。
// 标签现在存独立 JSON 文件：默认 Yes/No 不落盘（无文件 = 默认），
// 只有用户新增/删除后才创建文件；列表回到默认时删除文件。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  apply, DEFAULT_TAGS, normalizeTags, readTagsFile, resolveTagsFile, writeTagsFile,
} from '../lib/index.js'

function tempTagsFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-annotation-tags-'))
  return join(dir, 'dsh-annotation-tags.json')
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    setHeader(key, value) { res.headers[key] = value },
    end(chunk) { if (chunk !== undefined) res.body += String(chunk); res.ended = true },
  }
  return res
}

function fakeReq(method, { body = '', headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  setImmediate(() => {
    if (body !== '') req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

async function waitEnded(res) {
  for (let i = 0; i < 100 && !res.ended; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(res.ended, true, '路由必须结束响应')
}

function mount(tagsFile) {
  let route
  apply({
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'], '插件通过 ctx.inject 声明 webServer 依赖')
      callback({
        webServer: { register(value) { route = value; return () => {} } },
        effect(fn) { fn(); return () => {} },
      })
      return {}
    },
  }, { tagsFile })
  assert.ok(route, '插件应注册 /annotation-tags 路由')
  return route
}

const json = (value) => JSON.parse(value)

test('默认标签：没有 JSON 文件时返回 Yes / No，且不创建文件', async () => {
  const file = tempTagsFile()
  const route = mount(file)
  const res = fakeRes()
  route.handler(fakeReq('GET'), res)
  await waitEnded(res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json(res.body).tags, DEFAULT_TAGS)
  assert.equal(existsSync(file), false, '默认标签不应创建持久化文件')
  assert.equal(readTagsFile(file), null)
})

test('新增标签：创建独立 JSON 文件；删除默认标签也会持久化', async () => {
  const file = tempTagsFile()
  const route = mount(file)

  const add = fakeRes()
  route.handler(fakeReq('POST', { body: JSON.stringify({ action: 'add', tag: '  常用  ' }) }), add)
  await waitEnded(add)
  assert.equal(add.statusCode, 200)
  assert.deepEqual(json(add.body).tags, ['Yes', 'No', '常用'])
  assert.equal(existsSync(file), true, '有自定义标签后才创建 JSON 文件')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(saved.tags, ['Yes', 'No', '常用'])

  const remove = fakeRes()
  route.handler(fakeReq('POST', { body: JSON.stringify({ action: 'remove', tag: 'No' }) }), remove)
  await waitEnded(remove)
  assert.deepEqual(json(remove.body).tags, ['Yes', '常用'])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tags, ['Yes', '常用'])
})

test('标签列表回到默认时删除文件（默认标签永远不落盘）', async () => {
  const file = tempTagsFile()
  const route = mount(file)

  const add = fakeRes()
  route.handler(fakeReq('POST', { body: JSON.stringify({ action: 'add', tag: '临时' }) }), add)
  await waitEnded(add)
  assert.equal(existsSync(file), true)

  const remove = fakeRes()
  route.handler(fakeReq('POST', { body: JSON.stringify({ action: 'remove', tag: '临时' }) }), remove)
  await waitEnded(remove)
  assert.deepEqual(json(remove.body).tags, DEFAULT_TAGS)
  assert.equal(existsSync(file), false, '回到默认后应删除文件，重新变成「无文件 = 默认」')
})

test('重复新增不产生重复项、重复删除保持稳定', async () => {
  const file = tempTagsFile()
  const route = mount(file)
  const add = fakeRes()
  route.handler(fakeReq('POST', { body: JSON.stringify({ action: 'add', tag: 'Yes' }) }), add)
  await waitEnded(add)
  assert.deepEqual(json(add.body).tags, DEFAULT_TAGS)
  assert.equal(existsSync(file), false)

  const remove = fakeRes()
  route.handler(fakeReq('POST', { body: JSON.stringify({ action: 'remove', tag: 'nope' }) }), remove)
  await waitEnded(remove)
  assert.deepEqual(json(remove.body).tags, DEFAULT_TAGS)
})

test('损坏/空文件回落到默认，不覆盖用户文件', async () => {
  const file = tempTagsFile()
  writeFileSync(file, '{oops', 'utf8')
  const route = mount(file)
  const res = fakeRes()
  route.handler(fakeReq('GET'), res)
  await waitEnded(res)
  assert.deepEqual(json(res.body).tags, DEFAULT_TAGS, '损坏文件按默认标签处理')
  assert.equal(readFileSync(file, 'utf8'), '{oops', '读取失败时不能改写文件')
})

test('兼容数组格式的 JSON 文件', () => {
  const file = tempTagsFile()
  writeFileSync(file, '["A","B","A"]', 'utf8')
  assert.deepEqual(readTagsFile(file), ['A', 'B'])
})

test('标签规整：去空白、去重、限长限量；非数组视为无数据', () => {
  assert.equal(normalizeTags(undefined), null)
  assert.equal(normalizeTags('Yes'), null)
  assert.deepEqual(normalizeTags([' a ', 'a', '', 3, 'b']), ['a', 'b'])
  const long = 'x'.repeat(40)
  assert.equal(normalizeTags([long])[0].length, 24)
  const many = Array.from({ length: 40 }, (_, i) => 't' + i)
  assert.equal(normalizeTags(many).length, 24)
})

test('writeTagsFile：默认列表删除文件，自定义列表写 JSON', () => {
  const file = tempTagsFile()
  writeTagsFile(file, ['A'])
  assert.equal(existsSync(file), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tags, ['A'])
  writeTagsFile(file, DEFAULT_TAGS.slice())
  assert.equal(existsSync(file), false)
})

test('resolveTagsFile：显式 config.tagsFile 优先，否则落在 DSH home 的固定文件名', () => {
  assert.equal(resolveTagsFile({ tagsFile: 'D:/tmp/tags.json' }), 'D:/tmp/tags.json')
  assert.match(resolveTagsFile({}), /dsh-annotation-tags\.json$/)
})

test('路由拒绝非法请求：方法、JSON、动作、标签、跨源', async () => {
  const file = tempTagsFile()
  const route = mount(file)

  const wrongMethod = fakeRes()
  route.handler(fakeReq('DELETE'), wrongMethod)
  await waitEnded(wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)

  const badJson = fakeRes()
  route.handler(fakeReq('POST', { body: '{oops' }), badJson)
  await waitEnded(badJson)
  assert.equal(badJson.statusCode, 400)

  const badAction = fakeRes()
  route.handler(fakeReq('POST', { body: JSON.stringify({ action: 'nuke', tag: 'x' }) }), badAction)
  await waitEnded(badAction)
  assert.equal(badAction.statusCode, 400)

  const badTag = fakeRes()
  route.handler(fakeReq('POST', { body: JSON.stringify({ action: 'add', tag: '   ' }) }), badTag)
  await waitEnded(badTag)
  assert.equal(badTag.statusCode, 400)

  const crossOrigin = fakeRes()
  route.handler(fakeReq('POST', {
    headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' },
    body: JSON.stringify({ action: 'add', tag: 'x' }),
  }), crossOrigin)
  await waitEnded(crossOrigin)
  assert.equal(crossOrigin.statusCode, 403)
  assert.equal(existsSync(file), false, '被拒绝的请求不能创建文件')
})

test('没有 webServer 服务时插件仍可加载（headless profile 不注册路由）', () => {
  const file = tempTagsFile()
  // 依赖一直不可用：ctx.inject 不会执行回调，插件本体也不能抛错/激活失败。
  assert.doesNotThrow(() => apply({
    inject() { return {} },
  }, { tagsFile: file }))
  assert.equal(existsSync(file), false)
})

test('访问 webServer 只能通过 ctx.inject，不能在未声明依赖时直读服务属性', () => {
  const file = tempTagsFile()
  // 模拟 cordis 的上下文代理：未 inject 时访问 webServer 会抛错。
  let route = null
  const ctx = new Proxy({
    inject(deps, callback) {
      callback({
        webServer: { register(value) { route = value; return () => {} } },
        effect(fn) { fn(); return () => {} },
      })
      return {}
    },
  }, {
    get(target, prop) {
      if (prop === 'webServer') throw new Error('cannot get property "webServer" without inject')
      return target[prop]
    },
  })
  assert.doesNotThrow(() => apply(ctx, { tagsFile: file }))
  assert.ok(route, '通过 ctx.inject 拿到 webServer 后正常注册路由')
})
