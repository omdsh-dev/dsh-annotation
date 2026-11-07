import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const background = 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #2c2c2e))'

test('annotation surfaces use solid theme layers without menu alpha (issue #69)', () => {
  assert.doesNotMatch(source, /--dsw-specific-menu|color-mix\(/)
  for (const selector of ['.dsh-ann-bar {', '.dsh-ann-card {']) {
    const rule = source.slice(source.indexOf(selector), source.indexOf(" }',", source.indexOf(selector)))
    assert.ok(rule.includes(`background: ${background};`), selector)
  }
  assert.equal(source.split(`background:${background};`).length - 1, 8,
    'toast, pending chip, bubble/reply chips, queue tag and their floating panels share the solid surface')
  assert.doesNotMatch(source, /background:.*!important/,
    'readability must not depend on a hover-only background override')
})
