// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setContent(`<style>body{margin:0} [data-composer-card]{position:fixed;left:200px;top:600px;width:600px;height:150px;background:white}</style>
    <div class="wSkVaW_header" style="position:fixed;left:0;top:0;width:1000px;height:60px;background:#eee"></div>
    <div data-chat-flow-kind="assistant-step" style="position:absolute;left:250px;top:350px"><p id="quote">这是用来验证批注拖动和高亮遮挡的原文。</p></div>
    <div data-composer-card><div data-composer-input contenteditable="true">输入内容</div></div>`)
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } }
  })
  await page.addScriptTag({ path: fileURLToPath(new URL('../client.js', import.meta.url)) })
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
  // 工具条刚随选区出现时不显示预览（否则会和系统默认的选区渲染叠在一起）。
  const barPreview = await page.evaluate(() => {
    const quoteRect = document.querySelector('#quote').getBoundingClientRect()
    const rects = Array.from(document.querySelectorAll('.dsh-ann-hl-preview'))
      .filter(el => el.style.display !== 'none')
      .map(el => el.getBoundingClientRect())
    return {
      count: rects.length,
      coversQuote: rects.some(r => r.top < quoteRect.bottom && r.bottom > quoteRect.top
        && r.left < quoteRect.right && r.right > quoteRect.left),
    }
  })
  assert.equal(barPreview.count, 0, '工具条刚出现时不显示预览（避免与系统选区渲染重叠）')

  // 点「标签」展开面板：预览出现；再点收起：预览保持（点过按钮后就有效）。
  await page.locator('.dsh-ann-tag-toggle').click()
  await page.locator('.dsh-ann-tags').waitFor()
  const tagPreview = await page.evaluate(() => {
    const quoteRect = document.querySelector('#quote').getBoundingClientRect()
    const rects = Array.from(document.querySelectorAll('.dsh-ann-hl-preview'))
      .filter(el => el.style.display !== 'none').map(el => el.getBoundingClientRect())
    return {
      count: rects.length,
      coversQuote: rects.some(r => r.top < quoteRect.bottom && r.bottom > quoteRect.top
        && r.left < quoteRect.right && r.right > quoteRect.left),
    }
  })
  assert.equal(tagPreview.count, 1, '点「标签」展开面板后预览高亮出现')
  assert.equal(tagPreview.coversQuote, true, '标签面板阶段的预览高亮覆盖选区')
  await page.locator('.dsh-ann-tag-toggle').click()
  await page.waitForTimeout(300)
  assert.equal(await page.locator('.dsh-ann-hl-preview:visible').count(), 1, '收起标签面板后预览高亮保持')
  await page.locator('.dsh-ann-bar button').click()
  await page.locator('.dsh-ann-input').waitFor()
  // 新增需求：点「批注」进入编辑浮窗时，刚选中的原文立刻以高亮显示，方便用户
  // 确认将要批注的内容；放弃本次批注（点 X）时撤销这块预览高亮。
  const previewHighlight = await page.evaluate(() => {
    const quoteRect = document.querySelector('#quote').getBoundingClientRect()
    const rects = Array.from(document.querySelectorAll('.dsh-ann-hl-preview'))
      .filter(el => el.style.display !== 'none')
      .map(el => el.getBoundingClientRect())
    return {
      count: rects.length,
      coversQuote: rects.some(r => r.top < quoteRect.bottom && r.bottom > quoteRect.top
        && r.left < quoteRect.right && r.right > quoteRect.left),
    }
  })
  assert.equal(previewHighlight.count, 1, '进入编辑浮窗时选区立即变为高亮（一条预览高亮）')
  assert.equal(previewHighlight.coversQuote, true, '预览高亮必须覆盖选中的原文')
  await page.locator('.dsh-ann-card-head .dsh-ann-icon').click()
  assert.equal(await page.locator('.dsh-ann-card').count(), 0, 'X 关闭编辑浮窗')
  const previewAfterCancel = await page.evaluate(() => Array.from(document.querySelectorAll('.dsh-ann-hl-preview'))
    .filter(el => el.style.display !== 'none').length)
  assert.equal(previewAfterCancel, 0, '放弃本次批注后撤销预览高亮')
  // 重新选中同一段原文，继续原有用例（拖动、保存后的正式高亮等）。
  await page.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('#quote'))
    getSelection().removeAllRanges(); getSelection().addRange(range)
  })
  await page.locator('.dsh-ann-bar').waitFor()
  await page.locator('.dsh-ann-bar button').click()
  await page.locator('.dsh-ann-input').fill('拖动后不能丢失的批注')
  assert.equal(await page.locator('.dsh-ann-card-head .dsh-ann-qdel').count(), 0, '新增批注时标题旁没有删除按钮')
  assert.equal(await page.locator('.dsh-ann-cancel').count(), 0, '编辑窗口没有取消按钮')
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
  await page.locator('.dsh-ann-num').first().waitFor()
  assert.equal(await page.locator('.dsh-ann-num').first().getAttribute('title'), '拖动后不能丢失的批注',
    '编号 hover 提示显示批注内容（前 10 个字符）')
  // 输入框覆盖到内容上（悬浮输入区）：高亮被裁掉，编号也不与输入框相交。
  await page.evaluate(() => {
    const composer = document.querySelector('[data-composer-card]')
    composer.style.top = '340px'
    composer.style.left = '240px'
    window.dispatchEvent(new Event('resize'))
  })
  await page.waitForTimeout(200)
  const composerOverlap = await page.evaluate(() => {
    const layer = document.querySelector('[data-annotation-overlay]')
    const numLayer = document.querySelector('[data-annotation-num-layer]')
    const hl = document.querySelector('.dsh-ann-hl')
    const keep = { left: hl.style.left, top: hl.style.top }
    hl.style.left = '260px'
    hl.style.top = '350px'
    const highlightPainted = document.elementsFromPoint(265, 355)
      .some(el => el.hasAttribute('data-annotation-overlay'))
    hl.style.left = keep.left
    hl.style.top = keep.top
    const composer = document.querySelector('[data-composer-card]').getBoundingClientRect()
    const marker = numLayer.querySelector('.dsh-ann-num')
    let overlaps = false
    if (marker !== null) {
      const r = marker.getBoundingClientRect()
      overlaps = r.left < composer.right && r.right > composer.left
        && r.top < composer.bottom && r.bottom > composer.top
    }
    return {
      highlightPainted,
      clipPath: layer.style.clipPath,
      numClipPath: numLayer.style.clipPath,
      markerHidden: marker === null,
      overlaps,
    }
  })
  assert.equal(composerOverlap.highlightPainted, false, '输入区域内的高亮被裁掉，不遮挡输入')
  assert.match(composerOverlap.clipPath, /polygon/, '标记层使用裁剪路径')
  assert.match(composerOverlap.numClipPath, /polygon/, '编号层同样带裁剪路径兜底')
  assert.ok(composerOverlap.markerHidden || !composerOverlap.overlaps,
    `编号不能压在输入框上：${JSON.stringify(composerOverlap)}`)
  await page.evaluate(() => {
    document.querySelector('[data-composer-card]').style.top = '550px'
    window.dispatchEvent(new Event('resize'))
  })
  await page.waitForTimeout(100)
  await page.locator('.dsh-ann-num').click()
  assert.equal(await page.locator('.dsh-ann-input').inputValue(), '拖动后不能丢失的批注')
  assert.equal(await page.locator('.dsh-ann-cancel').count(), 0, '编辑窗口不再有取消按钮')
  assert.equal(await page.locator('.dsh-ann-card-head .dsh-ann-qdel').count(), 1, '标题右侧有删除按钮')
  // 标记层把会话头部区域裁掉：高亮不盖在头部之上（编号另有让位/隐藏规则）。
  const headerClip = await page.evaluate(() => {
    const hl = document.querySelector('.dsh-ann-hl')
    const keep = { left: hl.style.left, top: hl.style.top }
    hl.style.left = '260px'
    hl.style.top = '20px'
    const inHeader = document.elementsFromPoint(265, 25)
      .some(el => el.hasAttribute('data-annotation-overlay'))
    hl.style.left = keep.left
    hl.style.top = keep.top
    return inHeader
  })
  assert.equal(headerClip, false, '会话头部区域内的高亮被裁掉，不盖在头部之上')
  await page.locator('.dsh-ann-card-head .dsh-ann-icon').click()
  assert.equal(await page.locator('.dsh-ann-card').count(), 0, '关闭按钮不触发拖动')
  // 编号跨在头部边界上时：整条不画（不贴边钉住），绝不剩半截残影。
  await page.evaluate(() => {
    document.querySelector('[data-chat-flow-kind="assistant-step"]').style.top = '70px'
    window.dispatchEvent(new Event('resize'))
  })
  await page.waitForTimeout(200)
  const straddle = await page.evaluate(() => {
    const header = document.querySelector('.wSkVaW_header').getBoundingClientRect()
    const marker = document.querySelector('.dsh-ann-num')
    if (marker === null) return { hidden: true }
    const r = marker.getBoundingClientRect()
    return { hidden: false, top: Math.round(r.top), headerBottom: Math.round(header.bottom), full: r.top >= header.bottom }
  })
  assert.ok(straddle.hidden || straddle.full, `编号不能跨在头部边界上留下半截：${JSON.stringify(straddle)}`)

  // 批注很多时，清单浮窗必须完整待在正文可见区里（不越出视口、不压到输入框上）。
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.evaluate(() => {
    const composer = document.querySelector('[data-composer-card]')
    composer.style.left = '200px'
    composer.style.top = '600px'
    window.dispatchEvent(new Event('resize'))
  })
  await page.waitForTimeout(150)
  for (let n = 0; n < 8; n++) {
    await page.evaluate((index) => {
      const row = document.querySelector('[data-chat-flow-kind="assistant-step"]')
      let p = document.querySelector('#extra-quote-' + index)
      if (p === null) {
        p = document.createElement('p')
        p.id = 'extra-quote-' + index
        p.textContent = '第 ' + (index + 1) + ' 段用于堆高批注清单的原文内容。'
        row.appendChild(p)
      }
      const range = document.createRange()
      range.selectNodeContents(p)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
    }, n)
    await page.waitForTimeout(150)
    await page.locator('.dsh-ann-bar button').click()
    await page.locator('.dsh-ann-input').fill('批注内容 ' + (n + 1))
    await page.locator('.dsh-ann-action').click()
    await page.waitForTimeout(80)
  }
  // 直接派发 mouseenter（悬停面板本身会挡住指针检查，用事件触发等价路径）。
  await page.evaluate(() => {
    document.querySelector('[data-annotation-chip]').dispatchEvent(new MouseEvent('mouseenter'))
  })
  await page.locator('.dsh-ann-tip').waitFor({ state: 'visible', timeout: 5000 })
  const tip = await page.evaluate(() => {
    const el = document.querySelector('.dsh-ann-tip')
    const r = el.getBoundingClientRect()
    const composer = document.querySelector('[data-composer-card]').getBoundingClientRect()
    return {
      title: (el.firstChild === null ? '' : el.firstChild.textContent) || '',
      rect: { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1,
      overlapsComposer: r.left < composer.right && r.right > composer.left && r.top < composer.bottom && r.bottom > composer.top,
      scrollable: el.scrollHeight > el.clientHeight + 1,
    }
  })
  assert.ok(tip.inViewport, `清单浮窗必须完整在视口内：${JSON.stringify(tip)}`)
  assert.equal(tip.overlapsComposer, false, `清单浮窗不能压到输入框上：${JSON.stringify(tip)}`)

  // 标题右侧的删除按钮：连同标记与待发送清单一起删掉。
  const chipCount = async () => {
    const text = (await page.locator('[data-annotation-chip]').textContent()) || ''
    const hit = text.match(/\d+/)
    return hit === null ? 0 : Number(hit[0])
  }
  const beforeCount = await chipCount()
  await page.locator('.dsh-ann-num').first().click()
  await page.locator('.dsh-ann-card-head .dsh-ann-qdel').click()
  assert.equal(await chipCount(), beforeCount - 1, '删除按钮把该批注从待发送清单里移除')
  assert.equal(await page.locator('.dsh-ann-card').count(), 0, '删除后编辑窗口关闭')
  await page.evaluate(() => window.dispose())
  assert.deepEqual(errors, [])
  console.log('PASS: 工具条下方定位、标题栏拖动、边界、缩放、保存、裁剪、头部遮挡、边界残影、清单浮窗、重新编辑、删除、无页面错误')
} finally {
  await browser.close()
}
