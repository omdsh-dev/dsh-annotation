// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
// Regression: the host renders a local submission echo (data-submission-echo)
// with the raw draft before the durable user message arrives. The echo is not
// part of allMessageRows, so the old decorator left the whole annotation block
// visible until the durable row replaced it (the send-time flash).
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.route('http://annotation.test/', route => route.fulfill({ contentType: 'text/html', body: `
    <style>
      body { margin:0; font-family:system-ui }
      [data-chat-flow-kind] { margin: 12px 20px; }
      .bubble { white-space: pre-wrap; }
    </style>
    <div id="chat"></div>
    <div data-composer-card><div data-composer-input contenteditable="true"></div></div>` }))
  await page.goto('http://annotation.test/')
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } }
  })
  await page.addScriptTag({ path: new URL('../client.js', import.meta.url).pathname })
  await page.evaluate(() => {
    window.dispose = window.api.apply({
      sessions: {
        list: { getSnapshot: () => ({ current: 'session' }), subscribe: () => () => {} },
        scope: () => ({}),
      },
      conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ draft: '' }), subscribe: () => () => {} } }) } },
      locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
    })
  })

  const block = '我批注了以下 1 处内容（编号与原文对应），请针对它们回答我的问题：\n\n'
    + '1. 原文片段\n   批注：解释一下\n\n'
    + '请用「Annotation 1：…」到「Annotation 1：…」的格式，逐条单独回应上面每一条批注，不要合并或跳过；即使某条无法回应，也要保留编号说明原因。最后再回答我的问题。\n\n'
    + '提问：'
  const sent = block + '\n我的问题'

  // Normal submission echo: not in [data-chat-flow-kind]. It must be hidden
  // and tagged in the same microtask turn, before the browser paints.
  const echoResult = await page.evaluate(async (text) => {
    const echo = document.createElement('div')
    echo.setAttribute('data-submission-echo', '')
    echo.className = 'userRow'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = text
    echo.appendChild(bubble)
    document.querySelector('#chat').appendChild(echo)
    await Promise.resolve()
    await Promise.resolve()
    return {
      text: bubble.textContent,
      tag: echo.querySelector('[data-annotation-bubble-tag]')?.textContent || '',
    }
  }, sent)
  assert.ok(echoResult.text.startsWith('我的问题'), 'echo keeps the question')
  assert.ok(!echoResult.text.includes('我批注了以下'), 'echo no longer shows the block')
  assert.match(echoResult.tag, /1/, 'echo carries the annotation tag')

  // Durable user row: the same decoration path.
  const durableResult = await page.evaluate(async (text) => {
    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-kind', 'user')
    row.setAttribute('data-chat-flow-key', 'user-1')
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = text
    row.appendChild(bubble)
    document.querySelector('#chat').appendChild(row)
    await Promise.resolve()
    await Promise.resolve()
    return {
      text: bubble.textContent,
      tag: row.querySelector('[data-annotation-bubble-tag]')?.textContent || '',
    }
  }, sent)
  assert.ok(durableResult.text.startsWith('我的问题'))
  assert.ok(!durableResult.text.includes('我批注了以下'))
  assert.match(durableResult.tag, /1/)

  // Reply chip maps to the immediately preceding user message; no coverage nag.
  const replyResult = await page.evaluate(async () => {
    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-kind', 'assistant-step')
    row.setAttribute('data-chat-flow-key', 'assistant-1')
    row.textContent = 'Annotation 1：这是回应。'
    document.querySelector('#chat').appendChild(row)
    await new Promise(resolve => setTimeout(resolve, 650))
    return {
      chips: row.querySelectorAll('[data-annotation-reply-chip]').length,
      unanswered: row.querySelectorAll('[data-annotation-unanswered]').length,
    }
  })
  assert.equal(replyResult.chips, 1, 'reply renders one inline chip')
  assert.equal(replyResult.unanswered, 0, 'the coverage nag is gone')

  assert.deepEqual(errors, [])
  console.log('PASS: submission echo and durable row hide the block before paint; reply chip; no coverage nag')
} finally {
  await browser.close()
}
