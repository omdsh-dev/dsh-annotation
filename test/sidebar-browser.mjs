// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.route('http://annotation.test/', route => route.fulfill({ contentType: 'text/html', body: `
    <style>body{margin:40px} [data-textpreview-url]{margin-left:500px} [data-composer-card]{position:fixed;bottom:20px}</style>
    <div data-chat-flow-kind="assistant-step"><p id="chat">重复的原文</p></div>
    <section data-textpreview-url="dsh-resource://file/session/session/docs/a.md">
      <div data-textpreview-path title="/workspace/docs/a.md">a.md</div>
      <div data-textpreview-body><div data-document-markdown><p id="quote">重复的原文</p></div></div>
    </section>
    <div data-composer-card><div data-composer-input contenteditable="true">请检查</div></div>` }))
  await page.goto('http://annotation.test/')
  const boot = async () => {
    await page.evaluate(() => {
      window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } }
    })
    await page.addScriptTag({ path: new URL('../client.js', import.meta.url).pathname })
    await page.evaluate(() => {
      window.draft = '请检查'
      window.dispose = window.api.apply({ sessions: {
        list: { getSnapshot: () => ({ current: 'session' }), subscribe: () => () => {} }, scope: () => ({}),
      }, conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ draft: window.draft }), subscribe: () => () => {} }, setDraft: value => { window.draft = value } }) } } })
    })
  }
  const select = async (selector = '#quote') => {
    await page.waitForTimeout(100)
    await page.evaluate(selector => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector(selector))
      getSelection().removeAllRanges(); getSelection().addRange(range)
    }, selector)
  }
  const add = async () => {
    await select()
    await page.locator('.dsh-ann-bar button').click()
    assert.match(await page.locator('.dsh-ann-quote').getAttribute('title'), /^\[docs\//)
    await page.locator('.dsh-ann-input').fill('解释这个文件')
    await page.locator('.dsh-ann-action').click()
    await page.waitForTimeout(100)
  }
  const records = () => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.annotation.pending.v1.session')))
  await boot()
  await add()
  assert.equal((await records())[0].sourcePath, 'docs/a.md')
  await page.evaluate(() => {
    const body = document.querySelector('[data-textpreview-body]')
    body.style.cssText = 'height:30px;overflow:auto'
    document.querySelector('[data-document-markdown]').style.height = '300px'
    body.scrollTop = 200
  })
  await page.waitForFunction(() => document.querySelectorAll('.dsh-ann-num').length === 0)
  assert.equal(await page.locator('.dsh-ann-num').count(), 0, '滚出预览区域的内容不在外面显示标记')
  await page.evaluate(() => { document.querySelector('[data-textpreview-body]').scrollTop = 0 })
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.dsh-ann-num').count(), 1)

  await page.evaluate(() => document.querySelector('[data-textpreview-url]').setAttribute('data-textpreview-url', 'dsh-resource://file/session/session/docs/b.md'))
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.dsh-ann-num').count(), 0, '相同文本的新文件不继承旧标记')
  await add()
  assert.equal((await records()).length, 2, '同文不同文件分别保存')
  await page.reload()
  await boot()
  await page.locator('.dsh-ann-num').waitFor()
  assert.equal(await page.locator('.dsh-ann-num').textContent(), '1', '重载仅标记当前文件')
  const marker = await page.locator('.dsh-ann-num').boundingBox()
  assert.ok(marker.x > 450, '不会误标聊天中的同文')
  await page.locator('.dsh-ann-num').click()
  assert.equal(await page.locator('.dsh-ann-input').inputValue(), '解释这个文件')
  await page.locator('.dsh-ann-card-head button').click()
  await page.locator('[data-composer-input]').press('Enter')
  const draft = await page.evaluate(() => window.draft)
  assert.ok(draft.includes('[docs/a.md]') && draft.includes('[docs/b.md]'), '两份文件路径都随原文拼稿')
  for (const attr of ['data-textpreview-plain', 'data-code-preview']) {
    await page.evaluate(attr => {
      document.querySelector('[data-textpreview-body]').innerHTML = `<div ${attr}><pre id="quote">重复的原文</pre></div>`
      document.querySelector('[data-textpreview-url]').setAttribute('data-textpreview-url', `dsh-resource://file/session/session/docs/${attr}.txt`)
    }, attr)
    await add()
  }
  assert.equal((await records()).length, 4, '文本、Markdown、代码选区均保存')
  await page.evaluate(() => document.querySelector('[data-textpreview-url]').setAttribute('data-textpreview-url', 'dsh-resource://file/session/other/docs/a.md'))
  await select()
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.dsh-ann-bar').count(), 0, '拒绝其他会话的文件')
  await page.evaluate(() => document.querySelector('[data-textpreview-url]').setAttribute('data-textpreview-url', 'dsh-resource://file/session/session/docs/%ZZ.md'))
  await select()
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.dsh-ann-bar').count(), 0, '拒绝畸形文件地址')
  await select('[data-textpreview-path]')
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.dsh-ann-bar').count(), 0, '文件标题不是可批注正文')
  await page.evaluate(() => window.dispose())
  assert.deepEqual(errors, [])
  console.log('PASS: 三种正文选区、来源路径、同文不同文件、切文件、刷新恢复、编辑、拼稿、会话隔离、畸形地址和标题排除')
} finally { await browser.close() }
