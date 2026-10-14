// Browser geometry/interaction coverage, not a native macOS window-drag test.
// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const client = readFileSync(process.env.CLIENT_PATH || new URL('../client.js', import.meta.url), 'utf8')
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  // The app-region rules are from DSH dsh-v0.2.0-rc.2, packages/client/web/src/base.css.
  await page.route('http://annotation.test/', route => route.fulfill({ contentType: 'text/html', body: `
    <html data-platform="darwin"><style>
      html[data-platform='darwin'] [data-window-drag] { -webkit-app-region: drag; }
      html[data-platform='darwin'] body > :not(#root) { -webkit-app-region: no-drag; }
      body { margin: 0; font: 16px sans-serif; } p { margin: 0; }
      #column { position: fixed; left: 100px; top: 0; width: 600px; }
      .fixture_header { height: 76px; background: white; }
      .fixture_scrollBody { height: 424px; overflow: auto; }
      #content { height: 1300px; padding-top: 120px; }
      #quote { margin-left: 40px; }
      [data-composer-card] { height: 100px; background: white; }
    </style><body><div id="root"><section id="column">
      <header class="fixture_header" data-window-drag>Conversation</header>
      <div class="fixture_scrollBody" data-conversation-scroll><div id="content">
        <div data-chat-flow-kind="assistant-step"><p id="quote">Window drag regression passage</p></div>
      </div></div>
      <div data-composer-card><div contenteditable="true" data-composer-input>Question</div></div>
    </section></div></body></html>` }))
  await page.goto('http://annotation.test/')
  const boot = async () => {
    await page.evaluate(() => { window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } } })
    await page.addScriptTag({ content: client })
    await page.evaluate(() => { window.dispose = window.api.apply({ sessions: {
      list: { getSnapshot: () => ({ current: 'session' }), subscribe: () => () => {} }, scope: () => ({}),
    } }) })
  }
  const inspectShells = async () => {
    const shells = await page.evaluate(() => ['[data-annotation-overlay]', '[data-annotation-num-layer]'].map(selector => {
      const el = document.querySelector(selector)
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return { width: rect.width, height: rect.height, left: rect.left, top: rect.top,
        bodyChild: el.parentElement === document.body, region: style.getPropertyValue('-webkit-app-region'),
        position: style.position, overflow: style.overflow, pointerEvents: style.pointerEvents, zIndex: style.zIndex }
    }))
    for (const [index, shell] of shells.entries()) {
      assert.deepEqual(shell, { width: 0, height: 0, left: 0, top: 0, bodyChild: true, region: 'no-drag',
        position: 'fixed', overflow: 'visible', pointerEvents: 'none', zIndex: index === 0 ? '900' : '1100' },
      'body-child no-drag shells must not subtract a viewport-sized rectangle')
    }
    assert.equal(await page.locator('[data-window-drag]').evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'drag')
  }
  const inspectAnnotation = async () => page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote'))
    const quote = range.getBoundingClientRect()
    const hl = document.querySelector('.dsh-ann-hl')
    const rect = hl.getBoundingClientRect()
    // A pointer-events:none element never occurs in elementsFromPoint. Temporarily
    // enable hit-testing on the actual highlight so a collapsed clip cannot pass.
    const keep = hl.style.pointerEvents
    hl.style.pointerEvents = 'auto'
    const painted = document.elementsFromPoint(rect.left + 2, rect.top + 2).includes(hl)
    hl.style.pointerEvents = keep
    const marker = document.querySelector('.dsh-ann-num')
    const mr = marker?.getBoundingClientRect()
    return { painted, aligned: Math.abs(rect.left - quote.left) < 1 && Math.abs(rect.top - quote.top) < 1
        && Math.abs(rect.width - quote.width) < 1 && Math.abs(rect.height - quote.height) < 1,
      markerClickable: !!mr && document.elementFromPoint(mr.left + mr.width / 2, mr.top + mr.height / 2) === marker }
  })
  await boot()
  await inspectShells() // The drag regression exists even before making an annotation.
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote'))
    getSelection().removeAllRanges(); getSelection().addRange(range)
  })
  await page.locator('.dsh-ann-bar button').click()
  await page.locator('.dsh-ann-input').fill('Keep this annotation visible')
  await page.locator('.dsh-ann-action').click()
  await page.locator('.dsh-ann-num').waitFor()
  await inspectShells()
  assert.deepEqual(await inspectAnnotation(), { painted: true, aligned: true, markerClickable: true })
  await page.locator('.dsh-ann-num').click()
  assert.equal(await page.locator('.dsh-ann-input').inputValue(), 'Keep this annotation visible')
  await page.locator('.dsh-ann-card-head .dsh-ann-icon').click()

  // Both layer clip paths must preserve body/sidebar painting while excluding
  // the header and composer. Probes are fixed-position children like real markers.
  const inspectClipping = async () => page.evaluate(() => {
    const points = [[150, 30], [150, 520], [150, 300], [740, 30], [innerWidth - 20, innerHeight - 20]]
    return ['[data-annotation-overlay]', '[data-annotation-num-layer]'].map(selector => {
      const layer = document.querySelector(selector)
      const paint = points.map(([x, y]) => {
        const probe = document.createElement('div')
        probe.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:10px;height:10px;pointer-events:auto;`
        layer.appendChild(probe)
        const visible = document.elementsFromPoint(x + 2, y + 2).includes(probe)
        probe.remove()
        return visible
      })
      return { paint, clip: layer.style.clipPath }
    })
  })
  const assertClipping = async () => {
    const result = await inspectClipping()
    for (const layer of result) assert.deepEqual(layer.paint, [false, false, true, true, true])
    assert.equal(result[0].clip, result[1].clip, 'highlight and number clipping stay synchronized')
  }
  await assertClipping()
  // Grow, then shrink the viewport without moving the passage or blockers. The
  // outer clip must refresh even if the marker geometry signature is unchanged.
  for (const viewport of [{ width: 1200, height: 900 }, { width: 800, height: 650 }]) {
    await page.setViewportSize(viewport)
    await page.waitForFunction(({ width, height }) => document.querySelector('[data-annotation-overlay]').style.clipPath
      .includes(`${width}px ${height}px`), viewport)
    await inspectShells()
    await assertClipping()
    assert.deepEqual(await inspectAnnotation(), { painted: true, aligned: true, markerClickable: true })
  }
  await page.evaluate(() => { document.querySelector('[data-conversation-scroll]').scrollTop = 150 })
  await page.waitForFunction(() => {
    const hl = document.querySelector('.dsh-ann-hl')
    return hl !== null && parseFloat(hl.style.top) < 76
  })
  assert.equal((await inspectAnnotation()).painted, false, 'scrolling the passage under the header clips it')
  assert.equal(await page.locator('.dsh-ann-num').count(), 0, 'no partial number remains on the header')
  await page.evaluate(() => { document.querySelector('[data-conversation-scroll]').scrollTop = 0 })
  await page.locator('.dsh-ann-num').waitFor()
  assert.deepEqual(await inspectAnnotation(), { painted: true, aligned: true, markerClickable: true })

  // Re-applying restores persisted annotations without recreating full-screen shells.
  await page.evaluate(() => window.dispose())
  assert.equal(await page.locator('[data-annotation-overlay], [data-annotation-num-layer]').count(), 0)
  await boot()
  await page.locator('.dsh-ann-num').waitFor()
  await inspectShells()
  assert.deepEqual(await inspectAnnotation(), { painted: true, aligned: true, markerClickable: true })
  await page.locator('.dsh-ann-num').click()
  await page.locator('.dsh-ann-card-head .dsh-ann-qdel').click()
  assert.equal(await page.locator('.dsh-ann-num, .dsh-ann-hl').count(), 0)
  await page.evaluate(() => window.dispose())
  assert.equal(await page.locator('[data-annotation-overlay], [data-annotation-num-layer]').count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: zero-area macOS no-drag shells; highlight/number geometry, clipping, resize, scroll, edit, restore, delete, disposal')
} finally { await browser.close() }
