// i18n 冒烟——独立 DOM 沙箱：fake locale/sessions/conversation 服务驱动真实
// client.js（不依赖 3080 会话），验证 zh/en 协议块生成、跨语言气泡隐藏/反解析。
import { chromium } from '/Users/changfenhuang/.codex/tools/playwright-cli/node_modules/playwright-core/index.mjs'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[error] ${m.text().slice(0, 200)}`) })
page.on('pageerror', (e) => errs.push(`[pageerror] ${String(e).slice(0, 200)}`))
let fails = 0
const step = (n, ok, extra = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${n}] ${extra}`)
}

await page.setContent(`<!doctype html><html><body>
  <div data-chat-flow-kind="assistant-step" id="arow">
    <p id="atext">The quick brown fox jumps over the lazy dog. This passage is long enough for annotation selection.</p>
  </div>
  <div data-composer-card id="composer"><textarea id="ta"></textarea></div>
  <script>
    window.__draft = ''
    window.__locale = {
      snap: { active: 'zh', locales: [], revision: 1 },
      listeners: [],
      getSnapshot() { return this.snap },
      subscribe(fn) { this.listeners.push(fn); return () => {} },
      setLocale(id) {
        this.snap = { active: id, locales: [], revision: this.snap.revision + 1 }
        this.listeners.forEach((fn) => fn())
      },
    }
    window.__shell = {
      state: { getSnapshot: () => ({ draft: window.__draft }) },
      setDraft: (v) => { window.__draft = v },
    }
    window.__ModuleLoader__ = {
      load(spec) {
        window.__annExports = spec.factory(() => ({}))
      },
    }
  </script>
</body></html>`)

await page.addScriptTag({ path: '/Users/changfenhuang/projects/Annotation_for_dsh/client.js' })

await page.evaluate(() => {
  window.__ctx = {
    locale: window.__locale,
    sessions: {
      list: {
        getSnapshot: () => ({ current: 's1' }),
        subscribe: () => () => {},
      },
      scope: (id) => ({ id }),
    },
    conversation: { input: { for: (sc) => window.__shell } },
  }
  window.__dispose = window.__annExports.apply(window.__ctx)
})

async function selectQuote() {
  await page.evaluate(() => {
    const text = document.getElementById('atext').firstChild
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(28, text.nodeValue.length))
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await page.waitForTimeout(450)
}

// ---- zh：选区 → 工具条 → 保存 → Enter 拼稿 ----
await selectQuote()
let bar = await page.evaluate(() => {
  const b = document.querySelector('[data-annotation-for-dsh] .dsh-ann-bar')
  return b ? [...b.querySelectorAll('button')].map((x) => x.textContent.trim()) : []
})
step('zh 工具条文案', bar.join() === '批注', JSON.stringify(bar))

await page.evaluate(() => {
  [...document.querySelectorAll('[data-annotation-for-dsh] .dsh-ann-bar button')]
    .find((x) => x.textContent.trim() === '批注').click()
})
await page.waitForTimeout(300)
let card = await page.evaluate(() => {
  const c = document.querySelector('[data-annotation-for-dsh] .dsh-ann-card')
  return {
    title: c && c.querySelector('.dsh-ann-card-title').textContent,
    placeholder: c && c.querySelector('.dsh-ann-input').placeholder,
    buttons: c ? [...c.querySelectorAll('button')].map((x) => x.textContent.trim()) : [],
  }
})
step('zh 编辑面板文案', card.title === '添加批注' && card.placeholder.includes('写下批注')
  && card.buttons.includes('保存批注'), JSON.stringify(card))

await page.evaluate(() => {
  const ta = document.querySelector('[data-annotation-for-dsh] .dsh-ann-input')
  ta.value = 'Test note'
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ;[...document.querySelectorAll('[data-annotation-for-dsh] .dsh-ann-card button')]
    .find((x) => x.textContent.trim() === '保存批注').click()
})
await page.waitForTimeout(300)
let chip = await page.evaluate(() => {
  const c = document.querySelector('[data-annotation-chip]')
  return { shown: c && c.style.display !== 'none', text: c && c.textContent }
})
step('zh 计数标签', chip.shown && chip.text === '1条批注', JSON.stringify(chip))

await page.evaluate(() => {
  window.__draft = 'My question?'
  const ta = document.querySelector('#ta')
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
})
let zhDraft = await page.evaluate(() => window.__draft)
step('zh 协议块', zhDraft.startsWith('我批注了以下 1 处内容') && zhDraft.includes('批注：Test note')
  && zhDraft.includes('\n\n提问：\nMy question?'), JSON.stringify(zhDraft))

// ---- en：locale 切换 → UI 重绘 + Enter 拼 en 协议块 ----
await page.evaluate(() => window.__locale.setLocale('en'))
await page.waitForTimeout(300)
let enChip = await page.evaluate(() => document.querySelector('[data-annotation-chip]').textContent)
step('en 计数标签实时切换', enChip === '1 annotation(s)', JSON.stringify(enChip))

await page.evaluate(() => {
  window.__draft = 'My question?'
  const ta = document.querySelector('#ta')
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
})
let enDraft = await page.evaluate(() => window.__draft)
step('en 协议块', enDraft.startsWith('I annotated the following 1 passage(s)')
  && enDraft.includes('Note: Test note') && enDraft.includes('\n\nAsk:\nMy question?'), JSON.stringify(enDraft))

// ---- 跨语言气泡隐藏 + 反解析（当前 locale=en，zh/en 历史块都要能吃） ----
async function insertBubble(blockText, id) {
  await page.evaluate(({ blockText, id }) => {
    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-kind', 'user-step')
    row.id = id
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = blockText
    row.appendChild(bubble)
    document.body.appendChild(row)
  }, { blockText, id })
  await page.waitForTimeout(1400)
  return page.evaluate((id) => {
    const row = document.getElementById(id)
    const bubble = row.querySelector('[class*="bubble"]')
    const tag = row.querySelector('[data-annotation-bubble-tag]')
    return {
      bubbleText: bubble.textContent,
      tagText: tag && tag.textContent,
      items: tag ? tag.__annotationItems : null,
    }
  }, id)
}

let enBubble = await insertBubble(enDraft, 'enrow')
step('en 历史气泡隐藏+标签', enBubble.bubbleText.trim().startsWith('My question?')
  && !enBubble.bubbleText.includes('Ask:') && !enBubble.bubbleText.includes('I annotated')
  && enBubble.tagText === 'Annotations ×1'
  && enBubble.items && enBubble.items.length === 1 && enBubble.items[0].note === 'Test note',
  JSON.stringify(enBubble))

let zhBubble = await insertBubble(zhDraft, 'zhrow')
step('zh 历史气泡跨语言解析', zhBubble.bubbleText.trim().startsWith('My question?')
  && !zhBubble.bubbleText.includes('提问：') && !zhBubble.bubbleText.includes('我批注了以下')
  && zhBubble.tagText === 'Annotations ×1'
  && zhBubble.items && zhBubble.items.length === 1 && zhBubble.items[0].note === 'Test note',
  JSON.stringify(zhBubble))

// ---- 切回 zh：历史 en 标签重新措辞 ----
await page.evaluate(() => window.__locale.setLocale('zh'))
await page.waitForTimeout(300)
let zhRetag = await page.evaluate(() =>
  [...document.querySelectorAll('[data-annotation-bubble-tag]')].map((t) => t.textContent))
step('切回 zh 历史标签重措辞', zhRetag.length === 2 && zhRetag.every((x) => x === '批注 ×1'),
  JSON.stringify(zhRetag))

await page.evaluate(() => window.__dispose())
step('无 console/page 错误', errs.length === 0, errs.join(' || ') || '(clean)')

await browser.close()
process.exit(fails > 0 || errs.length > 0 ? 1 : 0)
