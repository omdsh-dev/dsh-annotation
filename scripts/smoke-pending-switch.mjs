// 待发送批注跨会话生命周期冒烟——独立 DOM 沙箱：fake sessions/conversation 服务
// 驱动真实 client.js（不依赖 3080 会话），覆盖 issue #28 复测的回归：
//   会话 A 含历史已发送的带批注消息 → 挂待发送批注 → 切 B → 切回 A →
//   恢复出的待发送批注必须存活（历史消息重装饰不得误清空）。
// 同时验证真实发送仍会清空（watchInputDraft 草稿迁移是唯一权威）。
import { chromium } from '/Users/changfenhuang/.codex/tools/playwright-cli/node_modules/playwright-core/index.mjs'
import { createServer } from 'node:http'

const HTML = `<!doctype html><html><body>
  <div id="flow"></div>
  <div data-composer-card id="composer"><textarea id="ta"></textarea></div>
  <script>
    window.__shells = {}
    function makeShell() {
      const listeners = []
      const shell = {
        draft: '',
        lastSet: '',
        state: {
          getSnapshot: () => ({ draft: shell.draft }),
          subscribe(fn) { listeners.push(fn); return () => {} },
        },
        setDraft(v) { shell.draft = v; shell.lastSet = v; listeners.forEach((fn) => fn()) },
        clear() { shell.draft = ''; listeners.forEach((fn) => fn()) },
      }
      return shell
    }
    window.__sessions = {
      snap: { current: 'A' },
      listeners: [],
      getSnapshot() { return this.snap },
      subscribe(fn) { this.listeners.push(fn); return () => {} },
      switchTo(id) { this.snap = { current: id }; this.listeners.forEach((fn) => fn()) },
    }
    window.__ModuleLoader__ = {
      load(spec) { window.__annExports = spec.factory(() => ({})) },
    }
  </script>
</body></html>`

const srv = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(HTML) })
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${srv.address().port}`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[error] ${m.text().slice(0, 200)}`) })
page.on('pageerror', (e) => errs.push(`[pageerror] ${String(e).slice(0, 200)}`))
let fails = 0
const step = (n, ok, extra = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${n}] ${extra}`)
}

await page.goto(origin, { waitUntil: 'domcontentloaded' })
await page.addScriptTag({ path: new URL('../client.js', import.meta.url).pathname })

// 会话 DOM（真实协议块格式，反解析可命中）。切回时整体重灌，模拟 React 重建
// 后装饰标签（DOM 级修改）丢失、历史带批注消息以「未装饰」状态重新出现。
await page.evaluate(() => {
  window.__domA = `
    <div data-chat-flow-kind="assistant-step"><p>会话 A 的历史助手回复，足够长以便选择批注。</p></div>
    <div data-chat-flow-kind="user-step"><div class="x_bubble">我批注了以下 1 处内容（编号与原文对应），请针对它们回答我的问题：

1. 历史引用的助手文本
   批注：历史批注内容

请用「Annotation 1：…」到「Annotation 1：…」的格式，逐条回应上面每一条批注，最后再回答我的问题。

提问：历史问题</div></div>`
  window.__domB = `
    <div data-chat-flow-kind="assistant-step"><p>会话 B 的助手回复。</p></div>`
  document.getElementById('flow').innerHTML = window.__domA
})

const state = () => page.evaluate(() => ({
  chip: (() => { const c = document.querySelector('[data-annotation-chip]'); return c && c.style.display !== 'none' ? c.textContent.trim() : null })(),
  storedA: localStorage.getItem('dsh.annotation.pending.v1.A'),
}))

// ---- 启动：A 已有落盘的待发送批注，且历史带批注消息在场（覆盖「刷新即恢复」）----
await page.evaluate(() => {
  localStorage.setItem('dsh.annotation.pending.v1.A', JSON.stringify([{
    id: 'q-1', text: '待发送引用', note: '待发送批注',
    seqKey: '', rowHead: '', textOffset: -1, ctxBefore: '', ctxAfter: '',
  }]))
  window.__ctx = {
    sessions: { list: window.__sessions, scope: (id) => ({ id }) },
    conversation: { input: { for: (sc) => (window.__shells[sc.id] ??= makeShell()) } },
  }
  window.__dispose = window.__annExports.apply(window.__ctx)
})
await page.waitForTimeout(400)
let s = await state()
step('启动即恢复待发送批注（chip 可见，刷新路径）', s.chip !== null && s.storedA !== null, JSON.stringify(s))

// ---- 切到会话 B ----
await page.evaluate(() => {
  window.__sessions.switchTo('B')
  document.getElementById('flow').innerHTML = window.__domB
})
await page.waitForTimeout(300)
s = await state()
step('切到 B 后 chip 隐藏、A 存储保留', s.chip === null && s.storedA !== null, JSON.stringify(s))

// ---- 切回 A：历史带批注消息重新出现并被重装饰，待发送批注必须存活 ----
await page.evaluate(() => {
  window.__sessions.switchTo('A')
  document.getElementById('flow').innerHTML = window.__domA
})
await page.waitForTimeout(1500)
s = await state()
const deco = await page.evaluate(() => ({
  tagged: document.querySelectorAll('[data-annotation-bubble-tag]').length,
  tagText: (document.querySelector('[data-annotation-bubble-tag]') || {}).textContent,
  bubbleHasBlock: (document.querySelector('.x_bubble') || {}).textContent.includes('我批注了以下'),
}))
step('切回 A 后待发送批注仍存活（issue #28 复测回归）', s.chip !== null && s.storedA !== null, JSON.stringify(s))
step('历史消息仍被重装饰（标签 + 块隐藏）', deco.tagged === 1 && deco.tagText === '批注 ×1' && !deco.bubbleHasBlock, JSON.stringify(deco))

// ---- 真实发送仍会清空（watchInputDraft 草稿迁移是唯一权威）----
await page.evaluate(() => {
  const ta = document.getElementById('ta')
  ta.focus()
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
})
await page.waitForTimeout(200)
const attached = await page.evaluate(() => window.__shells.A.lastSet.includes('我批注了以下'))
step('裸 Enter 把批注块拼入草稿', attached)
await page.evaluate(() => {
  // 模拟宿主提交：草稿清空（watchInputDraft 的「有→空」迁移）+ 用户气泡渲染。
  const block = window.__shells.A.draft
  window.__shells.A.clear()
  const row = document.createElement('div')
  row.setAttribute('data-chat-flow-kind', 'user-step')
  row.innerHTML = `<div class="x_bubble"></div>`
  row.querySelector('.x_bubble').textContent = block + '新发送的问题'
  document.getElementById('flow').appendChild(row)
})
await page.waitForTimeout(1200)
s = await state()
const sendDeco = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-chat-flow-kind="user-step"]')]
  const last = rows[rows.length - 1]
  return {
    tagText: (last.querySelector('[data-annotation-bubble-tag]') || {}).textContent,
    blockHidden: !(last.querySelector('.x_bubble').textContent.includes('我批注了以下')),
  }
})
step('发送后待发送批注清空（内存 + 存储）', s.chip === null && s.storedA === null, JSON.stringify(s))
step('刚发送的消息用发送暂存数据贴标签', sendDeco.tagText === '批注 ×1' && sendDeco.blockHidden, JSON.stringify(sendDeco))

console.log('---CONSOLE---'); console.log(errs.join('\n') || '(none)')
srv.close()
await browser.close()
process.exit(fails > 0 || errs.length > 0 ? 1 : 0)
