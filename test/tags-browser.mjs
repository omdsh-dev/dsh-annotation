// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
// 快捷标签 UI：工具条「标签」按钮向右展开浮岛标签（默认 Yes / No）、点击标签
// 直接创建批注并让编号后跟随标签文字、hover 删除叉永久删除、末尾「+」新增、
// 同一原文重复选标签只替换不新增。持久化请求用页面内 fetch mock 记录。
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setContent(`<style>body{margin:0} [data-composer-card]{position:fixed;left:200px;top:600px;width:600px;height:150px;background:white}</style>
    <div data-chat-flow-kind="assistant-step" style="position:absolute;left:250px;top:350px"><p id="quote">这是用来验证快捷标签的原文。</p></div>
    <div data-composer-card><div data-composer-input contenteditable="true">输入内容</div></div>`)
  await page.evaluate(() => {
    const state = { tags: ['Yes', 'No'] }
    window.__tagCalls = []
    window.fetch = (url, init) => {
      const target = String(url)
      const method = (init && init.method) || 'GET'
      window.__tagCalls.push({ url: target, method, body: init && init.body ? String(init.body) : '' })
      if (target !== '/annotation-tags') return Promise.reject(new Error('unexpected url ' + target))
      if (method === 'GET') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tags: state.tags.slice() }) })
      }
      const payload = JSON.parse(String(init.body))
      if (payload.action === 'add' && !state.tags.includes(payload.tag)) state.tags.push(payload.tag)
      if (payload.action === 'remove') state.tags = state.tags.filter(t => t !== payload.tag)
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tags: state.tags.slice() }) })
    }
    window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } }
  })
  await page.addScriptTag({ path: fileURLToPath(new URL('../client.js', import.meta.url)) })
  await page.evaluate(() => {
    window.dispose = window.api.apply({ sessions: {
      list: { getSnapshot: () => ({}), subscribe: () => () => {} }, scope: () => undefined,
    } })
  })

  const selectQuote = async () => {
    await page.evaluate(() => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector('#quote'))
      getSelection().removeAllRanges()
      getSelection().addRange(range)
    })
    await page.locator('.dsh-ann-bar').waitFor()
  }
  const tagLabels = async () => (await page.locator('.dsh-ann-tag-label').allTextContents()).map((s) => s.trim())

  await selectQuote()
  const barButtons = page.locator('.dsh-ann-bar > button')
  assert.equal(await barButtons.count(), 1, '工具条只有「批注」一个原生按钮（兼容宿主 .dsh-ann-bar button 选择器）')
  const tagToggle = page.locator('.dsh-ann-tag-toggle')
  assert.equal(await tagToggle.getAttribute('role'), 'button', '标签入口是 role=button 的自定义控件')
  assert.equal(await tagToggle.getAttribute('aria-label'), '标签', '标签入口保留可访问名称')
  assert.equal(await page.locator('.dsh-ann-tag-toggle svg').count(), 1, '标签入口是紧凑图标按钮（不再是文字按钮）')

  // 展开：默认 Yes / No 浮岛 + 末尾「+」；只增删面板，不重建整条工具条（批注按钮不闪）
  await page.evaluate(() => { window.__barBefore = document.querySelector('.dsh-ann-bar') })
  await tagToggle.click()
  await page.locator('.dsh-ann-tags').waitFor()
  assert.ok(await page.locator('.dsh-ann-hl-preview:visible').count() >= 1, '展开标签面板时预览高亮保持（只要「+ 批注」浮窗显示就有效）')
  assert.equal(await page.evaluate(() => window.__barBefore === document.querySelector('.dsh-ann-bar')), true,
    '展开标签不重建工具条（「批注」按钮不闪）')
  assert.equal(await page.locator('.dsh-ann-ghost.dsh-ann-ghost-dim').count(), 1, '展开标签时「批注」按钮变灰（二选一暗示）')
  // 收起：按钮立即恢复，面板逐渐缩回后才从 DOM 移除，然后重新展开继续
  await tagToggle.click()
  assert.equal(await page.locator('.dsh-ann-ghost-dim').count(), 0, '收起标签后「批注」按钮立即恢复')
  await page.waitForTimeout(400)
  assert.equal(await page.locator('.dsh-ann-tags').count(), 0, '收起动画结束后面板移除')
  await tagToggle.click()
  await page.locator('.dsh-ann-tags').waitFor()
  assert.deepEqual(await tagLabels(), ['Yes', 'No'], '默认标签是 Yes / No')
  assert.equal(await page.locator('.dsh-ann-tag-add').count(), 1, '末尾有新增按钮')

  // 点 Yes：直接创建批注，编号后跟随标签文字
  await page.locator('.dsh-ann-tag').first().click()
  await page.locator('.dsh-ann-num').first().waitFor()
  assert.equal((await page.locator('.dsh-ann-num-tag').first().textContent()).trim(), 'Yes', '编号后跟随所选标签')
  assert.equal((await page.locator('.dsh-ann-num').first().getAttribute('title')) || '', '',
    '标签批注的编号不显示 hover 提示')
  assert.equal(await page.locator('.dsh-ann-hl:visible').count() >= 1, true, '正文出现高亮')

  // hover 第一个标签 → 右上角圆圈叉可见 → 删除（永久移除持久化标签）
  await selectQuote()
  await tagToggle.click()
  await page.locator('.dsh-ann-tags').waitFor()
  await page.locator('.dsh-ann-tag').first().hover()
  assert.equal(await page.locator('.dsh-ann-tag-del').first().isVisible(), true, 'hover 时右上角出现删除叉')
  await page.locator('.dsh-ann-tag-del').first().click()
  await page.waitForTimeout(200)
  assert.deepEqual(await tagLabels(), ['No'], '删除后标签从面板消失')
  assert.equal(await page.locator('.dsh-ann-num-tag:visible').count(), 0, '已有批注的标签文字同步失效（编号保留）')
  assert.equal(await page.locator('.dsh-ann-num').count(), 1, '编号仍在')

  // 末尾「+」：空输入时再点「+」应恢复未点击状态，之后可重新打开并新增
  await page.locator('.dsh-ann-tag-add').click()
  await page.locator('.dsh-ann-tag-input').waitFor()
  await page.locator('.dsh-ann-tag-add').click()
  await page.waitForTimeout(80)
  assert.equal(await page.locator('.dsh-ann-tag-input').count(), 0, '空输入再点「+」恢复未点击「+」的状态')
  assert.equal(await page.locator('.dsh-ann-tag-add').count(), 1, '「+」按钮仍保留在面板末尾')

  await page.locator('.dsh-ann-tag-add').click()
  const input = page.locator('.dsh-ann-tag-input')
  await input.fill('常用')
  await input.press('Enter')
  await page.waitForTimeout(200)
  assert.deepEqual(await tagLabels(), ['No', '常用'], '新标签追加到末尾')

  // 同一原文再选「常用」：替换标签而不是新增第二条批注
  await page.locator('.dsh-ann-tag').nth(1).click()
  await page.waitForTimeout(200)
  assert.equal((await page.locator('.dsh-ann-num-tag:visible').first().textContent()).trim(), '常用')
  assert.equal(await page.locator('.dsh-ann-num').count(), 1, '同一原文只保留一条批注（替换标签）')

  const calls = await page.evaluate(() => window.__tagCalls)
  assert.ok(calls.some((call) => call.method === 'GET'), '启动时从 host 读取标签')
  assert.ok(calls.some((call) => call.method === 'POST' && JSON.parse(call.body).action === 'add'), '新增标签写入持久化')
  assert.ok(calls.some((call) => call.method === 'POST' && JSON.parse(call.body).action === 'remove'), '删除标签写入持久化')

  await page.evaluate(() => window.dispose())
  assert.deepEqual(errors, [])
  console.log('PASS: 标签面板展开、默认 Yes/No、选标签快捷批注、编号后跟随、hover 删除、+ 新增、每条批注只一个标签')
} finally {
  await browser.close()
}
