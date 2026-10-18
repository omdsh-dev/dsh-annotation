import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function extract(name) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n      \\}`))
  assert.ok(match, `client.js should define ${name}`)
  return match[0]
}

function bench(options = {}) {
  const { draft = 'typed question', quotes = 1, failRead = false } = options
  const current = 'current' in options ? options.current : 's1'
  const scope = 'scope' in options ? options.scope : {}
  let now = 1000
  let timerId = 0
  const timers = new Map()
  const calls = { attach: 0, submit: 0, reads: 0 }
  class Element {
    constructor(composer = false, card = false) { this.composer = composer; this.card = card }
    closest(selector) {
      if (selector === '[data-composer-input]') return this.composer ? this : null
      if (selector === '[data-composer-card]') return this.card ? this : null
      return null
    }
  }
  class HTMLTextAreaElement extends Element {}
  const sandbox = {
    Element, HTMLTextAreaElement,
    Date: { now: () => now },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, until: now + ms }); return id },
    clearTimeout(id) { timers.delete(id) },
    ui: { mode: 'closed', quotes: Array.from({ length: quotes }, () => ({})) },
    readCurrentSessionId: () => current,
    sessions: { scope: () => scope },
    ctx: { conversation: { input: { for: () => ({ state: { getSnapshot() {
      calls.reads++
      if (failRead) throw new Error('input not ready')
      return { draft }
    } } }) } } },
    attachAndSend: () => { calls.attach++; return true },
    submitAttached: () => { calls.submit++ },
    closeToolbar() {},
  }
  vm.createContext(sandbox)
  vm.runInContext([
    'var imeComposing = false, imeClearTimer = null, imeTouchedAt = 0',
    ...['markImeComposing', 'markImeEnded', 'isImeKeyBlocked', 'shouldAttachForEnter',
      'isCommandDraft', 'shouldGuardImeEnter', 'onKeyDown'].map(extract),
  ].join('\n'), sandbox)
  function event(overrides = {}) {
    return {
      key: 'Enter', keyCode: 13, isComposing: false, ctrlKey: false, metaKey: false,
      shiftKey: false, altKey: false, target: new Element(true, true),
      prevented: 0, stopped: 0,
      preventDefault() { this.prevented++ },
      stopPropagation() { this.stopped++ },
      ...overrides,
    }
  }
  return {
    calls, event, Element, HTMLTextAreaElement,
    start: () => sandbox.markImeComposing(),
    end: () => sandbox.markImeEnded(),
    key: e => sandbox.onKeyDown(e),
    advance(ms) {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.until <= now) { timers.delete(id); timer.fn() }
      }
    },
  }
}

test('post-composition Enter attaches and submits once after the 50ms guard expires', () => {
  const b = bench()
  b.start(); b.end(); b.advance(20)
  const guarded = b.event()
  b.key(guarded)
  assert.equal(guarded.stopped, 1)
  assert.equal(guarded.prevented, 0, 'native candidate acceptance remains available')
  assert.deepEqual(b.calls, { attach: 0, submit: 0, reads: 1 })
  b.advance(30)
  const next = b.event()
  b.key(next)
  assert.equal(b.calls.attach, 1)
  assert.equal(b.calls.submit, 1, 'plain Enter submits the assembled draft directly')
  assert.equal(next.stopped, 1)
  assert.equal(next.prevented, 1)
})

test('composition cancellation keeps the same post-composition protection', () => {
  const b = bench()
  b.start(); b.end(); b.advance(20)
  const e = b.event()
  b.key(e)
  assert.equal(e.stopped, 1)
  assert.equal(e.prevented, 0)
  b.advance(40)
  b.key(b.event())
  assert.equal(b.calls.attach, 1)
})

for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`native composition signal ${JSON.stringify(flags)} still reaches the editor`, () => {
    const b = bench()
    b.start(); b.end(); b.advance(20)
    const e = b.event(flags)
    b.key(e)
    assert.equal(e.stopped, 0)
    assert.equal(e.prevented, 0)
    assert.deepEqual(b.calls, { attach: 0, submit: 0, reads: 0 })
  })
}

test('active composition without compositionend preserves editor key handling', () => {
  const b = bench()
  b.start(); b.advance(20)
  const e = b.event()
  b.key(e)
  assert.equal(e.stopped, 0)
  assert.equal(e.prevented, 0)
  assert.equal(b.calls.attach, 0)
})

for (const [name, options, flags] of [
  ['typed Ctrl+Enter', {}, { ctrlKey: true }],
  ['typed Meta+Enter', {}, { metaKey: true }],
  ['slash command', { draft: '  /goal test' }, {}],
  ['no annotations', { quotes: 0 }, {}],
  ['Shift+Enter', {}, { shiftKey: true }],
  ['Alt+Enter', {}, { altKey: true }],
  ['normal typing', {}, { key: 'a', keyCode: 65 }],
]) {
  test(`${name} passes through the post-composition window`, () => {
    const b = bench(options)
    b.start(); b.end(); b.advance(20)
    const e = b.event(flags)
    b.key(e)
    assert.equal(e.stopped, 0)
    assert.equal(e.prevented, 0)
    assert.equal(b.calls.attach, 0)
    assert.equal(b.calls.submit, 0)
  })
}

test('Enter outside the composer passes through, including annotation fields', () => {
  const b = bench()
  b.start(); b.end(); b.advance(20)
  for (const target of [new b.HTMLTextAreaElement(), new b.Element(), null]) {
    const e = b.event({ target })
    b.key(e)
    assert.equal(e.stopped, 0)
    assert.equal(e.prevented, 0)
  }
  assert.deepEqual(b.calls, { attach: 0, submit: 0, reads: 0 })
})

test('legacy composer textarea receives the same guard', () => {
  const b = bench()
  b.start(); b.end(); b.advance(20)
  const e = b.event({ target: new b.HTMLTextAreaElement(false, true) })
  b.key(e)
  assert.equal(e.stopped, 1)
  assert.equal(e.prevented, 0)
})

for (const modifier of ['ctrlKey', 'metaKey']) {
  test(`empty-draft ${modifier} stays protected, then submits annotations normally`, () => {
    const b = bench({ draft: '' })
    b.start(); b.end(); b.advance(20)
    const e = b.event({ [modifier]: true })
    b.key(e)
    assert.equal(e.stopped, 1)
    assert.equal(e.prevented, 0)
    assert.equal(b.calls.submit, 0)
    b.advance(40)
    b.key(b.event({ [modifier]: true }))
    assert.equal(b.calls.attach, 1)
    assert.equal(b.calls.submit, 1)
  })
}

for (const [name, options] of [
  ['no current session', { current: undefined }],
  ['no session scope', { scope: undefined }],
  ['snapshot read failure', { failRead: true }],
]) {
  test(`unavailable composer state passes through: ${name}`, () => {
    const b = bench(options)
    b.start(); b.end(); b.advance(20)
    const e = b.event()
    b.key(e)
    assert.equal(e.stopped, 0)
    assert.equal(e.prevented, 0)
  })
}
