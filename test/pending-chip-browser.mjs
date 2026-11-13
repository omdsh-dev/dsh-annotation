// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
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
      [data-chat-flow-kind] { position:absolute; left:220px; top:240px }
      #seat { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); width:min(600px, calc(100vw - 40px)); background:#eee }
      [data-composer-card] { height:116px; background:white }
      [data-composer-input] { padding:16px }
      #queue { height:48px; position:relative; background:#ddd }
      #queue button { position:absolute; right:12px; bottom:8px; width:90px; height:24px }
    </style>
    <div data-chat-flow-kind="assistant-step"><p id="quote">A passage for the queued submit regression.</p></div>
    <div id="seat" class="wSkVaW_composerSeat" data-composer-seat>
      <div data-composer-card><div data-composer-input contenteditable="true">Keep this draft</div></div>
    </div>` }))
  await page.goto('http://annotation.test/')
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } }
    localStorage.setItem('dsh.annotation.pending.v1.session', JSON.stringify([
      { id: 'first', text: 'A passage for the queued submit regression.', note: 'first note' },
      { id: 'second', text: 'Another passage.', note: 'second note' },
    ]))
  })
  await page.addScriptTag({ path: fileURLToPath(new URL('../client.js', import.meta.url)) })
  await page.evaluate(() => {
    window.locale = 'zh'
    window.forceClicks = 0
    window.dispose = window.api.apply({ sessions: {
      list: { getSnapshot: () => ({ current: 'session' }), subscribe: () => () => {} }, scope: () => ({}),
    }, locale: {
      getSnapshot: () => ({ active: window.locale }),
      subscribe: fn => { window.changeLocale = fn; return () => {} },
    } })
  })
  const chip = page.locator('[data-annotation-chip]')
  await chip.waitFor({ state: 'visible' })
  assert.match(await chip.textContent(), /2/)
  const addQueue = () => page.evaluate(() => {
    const queue = document.createElement('div')
    queue.id = 'queue'
    queue.textContent = 'Queued message'
    const force = document.createElement('button')
    force.textContent = 'Force submit'
    force.addEventListener('click', () => { window.forceClicks++ })
    queue.appendChild(force)
    document.querySelector('#seat').prepend(queue)
  })
  const geometry = () => page.evaluate(() => {
    const chip = document.querySelector('[data-annotation-chip]').getBoundingClientRect()
    const seat = document.querySelector('#seat').getBoundingClientRect()
    const card = document.querySelector('[data-composer-card]').getBoundingClientRect()
    const force = document.querySelector('#queue button')?.getBoundingClientRect()
    const overlaps = force !== undefined && chip.left < force.right && chip.right > force.left
      && chip.top < force.bottom && chip.bottom > force.top
    return { chipBottom: chip.bottom, seatTop: seat.top, cardTop: card.top, chipLeft: chip.left, chipRight: chip.right, overlaps }
  })
  // The entry animation translates the chip by 3px. Visibility alone does not
  // mean its bounding box has settled, so compare queue removal against the
  // finished animation rather than a partially translated first frame.
  await chip.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
  const initial = await geometry()
  await addQueue()
  await page.waitForTimeout(150)
  let state = await geometry()
  assert.equal(state.cardTop, initial.cardTop, 'queue insertion does not resize or move the input card')
  assert.equal(state.overlaps, false, `pending chip cannot cover force-submit: ${JSON.stringify(state)}`)
  assert.ok(state.chipBottom <= state.seatTop - 5, `chip must clear the whole queued dock: ${JSON.stringify(state)}`)
  await page.locator('#queue button').click()
  assert.equal(await page.evaluate(() => window.forceClicks), 1, 'force-submit is really clickable')
  assert.equal(await page.locator('[data-composer-input]').textContent(), 'Keep this draft')

  await chip.hover()
  await page.locator('.dsh-ann-tip').waitFor({ state: 'visible' })
  assert.match(await page.locator('.dsh-ann-tip').textContent(), /first note/)
  const tipBottom = await page.locator('.dsh-ann-tip').evaluate(el => el.getBoundingClientRect().bottom)
  assert.ok(tipBottom <= state.seatTop, 'annotation list stays above the queue too')
  await page.mouse.move(10, 10)
  await page.locator('.dsh-ann-tip').waitFor({ state: 'hidden' })

  // A queue may expand after it is mounted, without changing the input card.
  await page.evaluate(() => { document.querySelector('#queue').style.height = '96px' })
  await page.waitForTimeout(150)
  state = await geometry()
  assert.ok(state.chipBottom <= state.seatTop - 5, 'seat ResizeObserver follows queue expansion')
  await page.locator('#queue button').click()
  assert.equal(await page.evaluate(() => window.forceClicks), 2)
  await page.evaluate(() => { document.querySelector('#queue').remove() })
  await page.waitForTimeout(150)
  state = await geometry()
  assert.ok(Math.abs(state.chipBottom - initial.chipBottom) < 1,
    `removing the queue returns the chip to its normal anchor: ${JSON.stringify({ initial, state })}`)

  // Old hosts expose the CSS-Modules seat instead of the stable data hook.
  await page.evaluate(() => { document.querySelector('#seat').removeAttribute('data-composer-seat') })
  await addQueue()
  await page.waitForTimeout(150)
  assert.ok((await geometry()).chipBottom <= (await geometry()).seatTop - 5)
  await page.locator('#queue button').click()
  assert.equal(await page.evaluate(() => window.forceClicks), 3)

  await page.setViewportSize({ width: 380, height: 600 })
  await page.evaluate(() => { window.locale = 'en'; window.changeLocale() })
  await page.waitForTimeout(150)
  state = await geometry()
  assert.match(await chip.textContent(), /2 annotation/)
  assert.ok(state.chipLeft >= 8 && state.chipRight <= 372, `English chip remains inside a narrow viewport: ${JSON.stringify(state)}`)
  assert.equal(state.overlaps, false)
  await page.locator('#queue button').click()
  assert.equal(await page.evaluate(() => window.forceClicks), 4)

  await page.evaluate(() => window.dispose())
  assert.equal(await chip.count(), 0, 'disposal removes the pending chip')
  assert.deepEqual(errors, [])
  console.log('PASS: queued submit remains clickable; queue insertion/resize/removal; CSS seat fallback; narrow viewport; locale; hover; draft; disposal')
} finally {
  await browser.close()
}
