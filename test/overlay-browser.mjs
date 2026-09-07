// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setContent(`<style>body{margin:0} [data-composer-card]{position:fixed;left:200px;top:600px;width:600px;height:150px;background:white}</style>
    <div data-chat-flow-kind="assistant-step" style="position:absolute;left:250px;top:350px"><p id="quote">这是用来验证批注拖动和高亮遮挡的原文。</p></div>
    <div data-composer-card><div data-composer-input contenteditable="true">输入内容</div></div>`)
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } }
  })
  await page.addScriptTag({ path: new URL('../client.js', import.meta.url).pathname })
  await page.evaluate(() => {
    window.dispose = window.api.apply({ sessions: {
      list: { getSnapshot: () => ({}), subscribe: () => () => {} }, scope: () => undefined,
    } })
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('#quote'))
    getSelection().removeAllRanges(); getSelection().addRange(range)
  })
  await page.locator('.dsh-ann-bar').waitFor()
  const quote = await page.locator('#quote').boundingBox()
  const bar = await page.locator('.dsh-ann-bar').boundingBox()
  assert.ok(bar.y >= quote.y + quote.height, '工具条位于选区下方')
  await page.locator('.dsh-ann-bar button').click()
  await page.locator('.dsh-ann-input').fill('拖动后不能丢失的批注')
  const before = await page.locator('.dsh-ann-card').boundingBox()
  const head = await page.locator('.dsh-ann-card-title').boundingBox()
  await page.mouse.move(head.x + 15, head.y + 5)
  await page.mouse.down()
  await page.mouse.move(980, 780, { steps: 5 })
  await page.mouse.up()
  const after = await page.locator('.dsh-ann-card').boundingBox()
  assert.ok(after.x !== before.x && after.y !== before.y, '标题栏可以拖动')
  assert.ok(after.x + after.width <= 993 && after.y + after.height <= 793, '窗口不会拖出屏幕')
  assert.equal(await page.locator('.dsh-ann-input').inputValue(), '拖动后不能丢失的批注')
  await page.setViewportSize({ width: 700, height: 650 })
  await page.waitForTimeout(100)
  const resized = await page.locator('.dsh-ann-card').boundingBox()
  assert.ok(resized.x + resized.width <= 693 && resized.y + resized.height <= 643, '缩小窗口仍可操作')
  await page.locator('.dsh-ann-action').click()
  await page.locator('.dsh-ann-hl').first().waitFor()
  // Make the numbered marker straddle the composer: clipped pixels must not intercept input.
  await page.evaluate(() => {
    const composer = document.querySelector('[data-composer-card]')
    composer.style.top = '340px'
    composer.style.left = '240px'
    window.dispatchEvent(new Event('resize'))
  })
  await page.waitForTimeout(100)
  assert.ok(await page.evaluate(() => {
    const layer = document.querySelector('[data-annotation-overlay]')
    const marker = document.querySelector('.dsh-ann-num')
    marker.style.left = '260px'; marker.style.top = '350px'
    const hit = document.elementFromPoint(265, 355)
    return CSS.supports('clip-path', layer.style.clipPath)
      && hit.closest('[data-composer-card]') !== null
  }), '高亮层和编号在输入区域被裁掉，不遮挡输入')
  await page.evaluate(() => {
    document.querySelector('[data-composer-card]').style.top = '550px'
    window.dispatchEvent(new Event('resize'))
  })
  await page.waitForTimeout(100)
  await page.locator('.dsh-ann-num').click()
  assert.equal(await page.locator('.dsh-ann-input').inputValue(), '拖动后不能丢失的批注')
  await page.locator('.dsh-ann-card-head button').click()
  assert.equal(await page.locator('.dsh-ann-card').count(), 0, '关闭按钮不触发拖动')
  await page.evaluate(() => window.dispose())
  assert.deepEqual(errors, [])
  console.log('PASS: 工具条下方定位、标题栏拖动、边界、缩放、保存、裁剪、重新编辑、取消、无页面错误')
} finally {
  await browser.close()
}
