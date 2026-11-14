// A real scroll/normal-flow header fixture; production bundle is never patched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const cases = [
  { name: 'current', client: readFileSync(new URL('../client.js', import.meta.url), 'utf8'), fixed: true },
  ...(process.env.BASELINE_CLIENT ? [{ name: '1.4.10', client: readFileSync(process.env.BASELINE_CLIENT, 'utf8'), fixed: false }] : []),
]
try {
  for (const entry of cases) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    await page.route('http://annotation.test/', route => route.fulfill({ contentType: 'text/html', body: `
      <style>body{margin:0;font:16px sans-serif}p{margin:0}#column{position:fixed;left:100px;top:0;width:700px;height:740px;display:flex;flex-direction:column}.actual_header{flex:none;height:76px;background:white}.actual_scrollBody{height:504px;overflow:auto;flex:none}#content{height:1300px;padding-top:80px}#quote{margin-left:40px}[data-composer-card]{height:160px;background:white}#sidebar{position:fixed;left:820px;top:0;width:180px;height:740px;background:#eee}</style>
      <section id="column"><header class="actual_header"><button id="header-button">Conversation title / action</button></header>
      <div class="actual_scrollBody" data-conversation-scroll><div id="content"><div data-time-hover-root data-chat-flow-kind="assistant-step"><p id="quote">Header overlap regression passage</p></div></div></div>
      <div data-composer-card><div contenteditable="true" data-composer-input>Question</div></div></section>
      <aside id="sidebar"><header class="actual_header">File preview title</header></aside>` }))
    const boot = async () => {
      await page.evaluate(() => { window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } } })
      await page.addScriptTag({ content: entry.client })
      await page.evaluate(() => { window.dispose = window.api.apply({ sessions: {
        list: { getSnapshot: () => ({ current: 'session' }), subscribe: () => () => {} }, scope: () => ({}),
      } }) })
    }
    await page.goto('http://annotation.test/')
    await boot()
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote'))
      getSelection().removeAllRanges(); getSelection().addRange(range)
    })
    await page.locator('.dsh-ann-bar button').first().click()
    await page.locator('.dsh-ann-input').fill('Header scroll note')
    await page.locator('.dsh-ann-action').click()
    await page.locator('.dsh-ann-hl').first().waitFor({ state: 'attached' })
    await page.waitForFunction(() => document.querySelector('.dsh-ann-num') !== null)
    const inspect = () => page.evaluate(() => {
      const header = document.querySelector('.actual_header').getBoundingClientRect()
      const highlights = [...document.querySelectorAll('.dsh-ann-hl')]
      // elementsFromPoint excludes pointer-events:none. Enable hit-testing only during
      // observation so this checks actual clip/paint eligibility, not that exclusion.
      let headerPaint = false
      for (const hl of highlights) {
        const r = hl.getBoundingClientRect(); const keep = hl.style.pointerEvents
        hl.style.pointerEvents = 'auto'
        const y = Math.max(r.top + 1, header.top + 1)
        if (y < Math.min(r.bottom, header.bottom)) headerPaint ||= document.elementsFromPoint(r.left + 2, y).includes(hl)
        hl.style.pointerEvents = keep
      }
      const markers = [...document.querySelectorAll('.dsh-ann-num')]
      // 标记层改为元素池后，不可见的编号留在 DOM 里（display:none），
      // 因此这里只统计真正渲染出来的编号（与旧实现的"移除即不可见"等价）。
      const visibleMarkers = markers.filter(el => el.getClientRects().length > 0)
      const markerOverlap = visibleMarkers.some(el => { const r = el.getBoundingClientRect(); return r.top < header.bottom && r.bottom > header.top })
      return { headerPaint, markerOverlap, markerCount: visibleMarkers.length,
        clip: document.querySelector('[data-annotation-overlay]').style.clipPath }
    })
    const scroll = async value => {
      await page.evaluate(value => { document.querySelector('[data-conversation-scroll]').scrollTop = value }, value)
      await page.waitForFunction(value => {
        const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote'))
        const r = range.getBoundingClientRect(); const hl = document.querySelector('.dsh-ann-hl')
        // 标记用 transform 定位（left/top 固定 0px），实际位置必须读渲染矩形。
        return hl !== null && Math.abs(hl.getBoundingClientRect().top - r.top) < 1
      }, value)
    }
    await scroll(120)
    const underHeader = await inspect()
    assert.equal(underHeader.headerPaint, !entry.fixed, `${entry.name}: real scrolling highlight under normal-flow header ${JSON.stringify(underHeader)}`)
    assert.equal(underHeader.markerOverlap, !entry.fixed, `${entry.name}: marker must disappear when scrolled under header`)
    await page.screenshot({ path: join(tmpdir(), `annotation-header-${entry.name}.png`) })
    // Restore the saved annotation while its source lies behind the header.
    await page.evaluate(() => { window.dispose(); document.getElementById('annotation-for-dsh-style')?.remove() })
    await boot()
    await page.waitForFunction(() => document.querySelector('.dsh-ann-hl') !== null)
    assert.equal((await inspect()).headerPaint, !entry.fixed, `${entry.name}: restored annotation follows the same header clipping`)
    await scroll(0)
    assert.ok((await inspect()).markerCount > 0, `${entry.name}: scrolling back restores the visible marker`)
    if (entry.fixed) {
      // Header height change is observed even when the selected passage itself has not changed.
      await page.evaluate(() => { document.querySelector('.actual_header').style.height = '100px'; window.dispatchEvent(new Event('resize')) })
      await scroll(120)
      assert.equal((await inspect()).headerPaint, false, 'resized normal-flow header still clips highlight')
      await page.evaluate(() => {
        const probe = document.createElement('div'); probe.className = 'dsh-ann-hl'
        probe.id = 'sidebar-probe'; probe.style.cssText = 'left:840px;top:30px;width:100px;height:14px;pointer-events:auto'
        document.querySelector('[data-annotation-overlay]').appendChild(probe)
      })
      assert.equal(await page.evaluate(() => document.elementsFromPoint(845, 35).includes(document.querySelector('#sidebar-probe'))), true,
        'conversation header clipping must not hide sidebar file highlights')
    }
    console.log(`PASS header scroll ${entry.name}: under-header paint=${underHeader.headerPaint}; marker-overlap=${underHeader.markerOverlap}; restore + scroll-back`)
    await page.close()
  }
} finally { await browser.close() }
