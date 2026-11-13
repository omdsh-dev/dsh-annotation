// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' }), headless: true })
try {
  for (const theme of [
    { layer: '#ffffff', base: '#fafafa', label: '#111111', expected: 'rgb(255, 255, 255)' },
    { layer: '#2c2c2e', base: '#181818', label: '#ffffff', expected: 'rgb(44, 44, 46)' },
  ]) {
    const page = await browser.newPage()
    await page.setContent(`<style>:root{--dsw-specific-menu:rgba(255,255,255,.15);--dsw-alias-bg-layer-2:${theme.layer};--dsw-alias-bg-base:${theme.base};--dsw-alias-label-primary:${theme.label}}</style><p>Underlying conversation text</p>`)
    await page.evaluate(() => { window.__ModuleLoader__ = { load(entry) { entry.factory(() => ({})) } } })
    await page.addScriptTag({ path: fileURLToPath(new URL('../client.js', import.meta.url)) })
    await page.evaluate(() => {
      for (const cls of ['dsh-ann-bar', 'dsh-ann-card']) {
        const el = document.createElement('div'); el.className = cls
        el.style.top = cls === 'dsh-ann-bar' ? '100px' : '200px'
        el.innerHTML = '<button>Keyboard control</button>'; document.body.appendChild(el)
      }
    })
    for (const cls of ['dsh-ann-bar', 'dsh-ann-card']) {
      const surface = page.locator('.' + cls)
      await page.mouse.move(0, 0)
      assert.equal(await surface.evaluate(el => getComputedStyle(el).backgroundColor), theme.expected, 'default surface is opaque')
      await surface.locator('button').focus()
      assert.equal(await surface.evaluate(el => getComputedStyle(el).backgroundColor), theme.expected, 'keyboard focus remains opaque')
      await surface.hover()
      assert.equal(await surface.evaluate(el => getComputedStyle(el).backgroundColor), theme.expected, 'hover remains opaque')
    }
    await page.evaluate(() => document.documentElement.style.removeProperty('--dsw-alias-bg-layer-2'))
    // Root declarations are in the stylesheet, so explicitly remove both tokens to exercise hard fallback.
    await page.addStyleTag({ content: ':root{--dsw-alias-bg-layer-2:initial;--dsw-alias-bg-base:initial}' })
    assert.equal(await page.locator('.dsh-ann-card').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(44, 44, 46)', 'missing theme tokens have an opaque fallback')
    await page.close()
  }
  console.log('PASS issue #69: light/dark default, focus, hover, and missing-token fallback')
} finally { await browser.close() }
