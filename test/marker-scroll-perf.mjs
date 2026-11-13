// DSH 批注插件「标记层滚动性能」基准。
//
// 每个批注规模 N 用一个全新页面，按真实交互（选区 → .dsh-ann-bar → 填批注 →
// .dsh-ann-action）生成 N 条批注，然后脚本化滚动 120 帧，采集：
//   * 滚动期间 rAF 帧间隔 p50/p95/max（驱动循环自己的时间戳差）；
//   * 插件 requestAnimationFrame 回调执行耗时 p50/p95/max——用 page.addInitScript
//     在 document 创建前包装 requestAnimationFrame，直接量化 renderMarkers() +
//     updateChip() 每帧占用主线程的时间；
//   * 每帧全文档 querySelectorAll 次数——monkey-patch Document.prototype.querySelectorAll
//     统计滚动期间调用总数（旧实现每条批注每帧重复 hostLocalRects，≈3N+11 次/帧；
//     新实现缓存宿主元素后应接近 0）；
//   * longtask：PerformanceObserver 的条目数与总时长；
//   * DOM 重建量：MutationObserver 观察 [data-annotation-overlay] 与
//     [data-annotation-num-layer] 子树，统计滚动期间的 childList mutation 条数
//     与 addedNodes 节点数（旧实现「每帧整体清空重建」的直接量化；元素池复用后≈0）；
//   * 滞后量（全部用 getBoundingClientRect，不读 style.top——新版标记用 transform 定位）：
//       - 滚动期间每帧测量 .dsh-ann-hl 与对应原文 Range 的 top/left 偏差
//         （单独的观测轮；该轮读 DOM 会扰动帧耗时，只用于滞后定性，不进性能基线）；
//       - 滚动停止后标记追上原文所需帧数，以及首帧/稳态偏差。
//
// 运行（Windows PowerShell）：
//   npm install --prefix "$env:TEMP\dsh-ann-perf" playwright-core --no-audit --no-fund
//     （默认 npm cache 不可写时加 --cache "$env:TEMP\npm-cache"）
//   $env:PLAYWRIGHT_MODULE = "$env:TEMP\dsh-ann-perf\node_modules\playwright-core"
//   node test/marker-scroll-perf.mjs                    # 跑 5/20/50，控制台摘要
//   node test/marker-scroll-perf.mjs --write-baseline   # 写 test/perf-baseline.json
//   node test/marker-scroll-perf.mjs --out="$env:TEMP\perf.json"  # 写临时目录（受限沙箱）
//   node test/marker-scroll-perf.mjs --json             # 完整 JSON 打到 stdout
//   node test/marker-scroll-perf.mjs --n=20             # 只跑一个规模
//   $env:BLOCK = '5,20'                                 # 等价缩减（BLOCK 或 --n 都行）
//   node test/marker-scroll-perf.mjs --frames=120 --rows=36
//
// 版本对比：默认只测工作树 client.js（变体名 current）。把改动前的旧实现另存
//   git show HEAD:client.js > "$env:TEMP\client-baseline.js"
//   $env:BASE_SCRIPT = "$env:TEMP\client-baseline.js"
// 后再跑，会在同一份报告里同时输出 baseline（旧实现）与 current（工作树）两个
// 变体，并生成 comparison（每项指标 current - baseline，负值 = 改善）。
//   PERF_VARIANTS=current|baseline|both 控制只跑哪一个（默认有 BASE_SCRIPT 时 both）。
//   CLIENT_SCRIPT 可覆盖「当前实现」的路径。
//
// 环境说明：
//   * 浏览器复用本机 Chrome（channel:'chrome'，不下载浏览器）。
//   * 受限沙箱里 chromium.launch() 会以 EPERM 失败（Playwright 用 pipe/子进程
//     stdio 做 CDP 通道，沙箱禁止）。此时脚本退回：用 PowerShell Start-Process
//     启动本机 Chrome（--remote-debugging-port），再用 chromium.connectOverCDP()
//     连接。设置 CHROME_CDP_PORT 可复用已启动的调试端口（脚本不会关掉它）。
//   * 页面用 page.route + goto 提供（不是 setContent）：addInitScript 只在
//     document 创建时执行，setContent 复用同一 document 不会触发它，rAF 包装器
//     会装不上。本地 http://annotation.test/ 也顺带让 pending 批注的
//     localStorage 可用。
//   * 受限沙箱里命令进程通常无权写工作区（node fs 写 test/ 报 EPERM）：用
//     --out=<临时路径> 输出，再用文件工具落盘到 test/perf-baseline.json。
//
// 只读取 client.js，不修改它；基准结果写到 test/perf-baseline.json。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const BASELINE_PATH = fileURLToPath(new URL('./perf-baseline.json', import.meta.url))
const PAGE_URL = 'http://annotation.test/'
const VIEWPORT = { width: 1000, height: 800 }
const DEFAULT_N = [5, 20, 50]
const DEFAULT_ROWS = 36
const DEFAULT_FRAMES = 120
const PARAGRAPHS_PER_ROW = 3
const LAUNCH_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

// ---------------------------------------------------------------- 参数

function usage() {
  return [
    '用法: node test/marker-scroll-perf.mjs [选项]',
    '  --n=5,20,50        批注规模列表（也可用环境变量 BLOCK 或 N）',
    '  --frames=120       滚动帧数（默认 120）',
    '  --rows=36          消息行数（限制在 30~40，默认 36）',
    '  --json             把完整 JSON 报告打到 stdout',
    '  --write-baseline   把结果写入 test/perf-baseline.json',
    '  --out=<path>       把完整 JSON 报告写到指定路径（受限沙箱里只能写临时目录）',
    '  --help             显示本帮助',
  ].join('\n')
}

function parseCountList(raw) {
  return String(raw).split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n > 0)
}

const cli = { n: null, frames: null, rows: null, json: false, writeBaseline: false, out: null, help: false }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--help' || arg === '-h') cli.help = true
  else if (arg === '--json') cli.json = true
  else if (arg === '--write-baseline') cli.writeBaseline = true
  else if (arg.startsWith('--out=')) cli.out = arg.slice(6)
  else if (arg === '--out') cli.out = argv[++i]
  else if (arg.startsWith('--n=')) cli.n = arg.slice(4)
  else if (arg === '--n') cli.n = argv[++i]
  else if (arg.startsWith('--frames=')) cli.frames = Number(arg.slice(9))
  else if (arg === '--frames') cli.frames = Number(argv[++i])
  else if (arg.startsWith('--rows=')) cli.rows = Number(arg.slice(7))
  else if (arg === '--rows') cli.rows = Number(argv[++i])
  else throw new Error('未知参数: ' + arg + '\n' + usage())
}

const rawN = cli.n || process.env.BLOCK || process.env.N || DEFAULT_N.join(',')
const nList = parseCountList(rawN)
if (nList.length === 0) throw new Error('--n / BLOCK 没有可用的批注规模')

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

const rows = clampInt(cli.rows, DEFAULT_ROWS, 30, 40)
const scrollFrames = clampInt(cli.frames, DEFAULT_FRAMES, 30, 600)
const maxAnnotations = rows * PARAGRAPHS_PER_ROW
for (const n of nList) {
  if (n > maxAnnotations) throw new Error('N=' + n + ' 超过可锚定段落总数 ' + maxAnnotations)
}

// 被测版本：默认当前工作树 client.js；BASE_SCRIPT 指向 git HEAD 里的旧实现
// （`git show HEAD:client.js > $env:TEMP\client-baseline.js`）时两版都测并对比。
const currentClientPath = path.resolve(process.env.CLIENT_SCRIPT || CLIENT_PATH)
const baselineClientPath = process.env.BASE_SCRIPT ? path.resolve(process.env.BASE_SCRIPT) : null
const variantsRequested = process.env.PERF_VARIANTS || (baselineClientPath ? 'both' : 'current')
if (baselineClientPath !== null && !existsSync(baselineClientPath)) {
  throw new Error('BASE_SCRIPT 指向的文件不存在: ' + baselineClientPath)
}
if (variantsRequested !== 'both' && variantsRequested !== 'current' && variantsRequested !== 'baseline') {
  throw new Error('PERF_VARIANTS 只能是 both / current / baseline')
}

// ---------------------------------------------------------------- Playwright 加载

/** 加载 playwright；PLAYWRIGHT_MODULE 允许指向安装目录（Windows 目录导入需要 file://）。 */
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_MODULE || 'playwright'
  const pick = mod => mod.chromium || (mod.default && mod.default.chromium)
  try {
    const mod = await import(spec)
    const chromium = pick(mod)
    if (chromium) return { chromium }
  } catch (error) {
    const code = String(error && (error.code || error.message))
    if (!/ERR_UNSUPPORTED_ESM_URL_SCHEME|ERR_UNSUPPORTED_DIR_IMPORT|ERR_MODULE_NOT_FOUND/.test(code)) throw error
  }
  const candidates = [spec, path.join(spec, 'index.js'), path.join(spec, 'index.mjs')]
  for (const candidate of candidates) {
    try {
      const href = path.isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate
      const mod = await import(href)
      const chromium = pick(mod)
      if (chromium) return { chromium }
    } catch (_) { /* 试下一个入口 */ }
  }
  throw new Error('无法加载 Playwright：把 PLAYWRIGHT_MODULE 指向 playwright / playwright-core 安装目录')
}

/** 读 playwright-core 版本（仅用于报告元信息）。 */
function playwrightVersion() {
  const spec = process.env.PLAYWRIGHT_MODULE
  if (!spec) return 'unknown'
  try { return JSON.parse(readFileSync(path.join(spec, 'package.json'), 'utf8')).version } catch (_) { return 'unknown' }
}

// ---------------------------------------------------------------- 浏览器启动

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error('找不到本机 Chrome，可设置 CHROME_PATH 指向 chrome.exe')
}

const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** 静默执行一个 PowerShell 子进程（stdio:'ignore'，避开沙箱对管道 stdio 的禁令）。 */
function runQuiet(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', code => resolve(code))
  })
}

function quoteArgument(value) {
  return /[\s"]/.test(value) ? '"' + String(value).replace(/"/g, '\\"') + '"' : String(value)
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

async function fetchChromeVersion(port) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/json/version')
    if (!response.ok) return null
    return await response.json()
  } catch (_) { return null }
}

async function waitForChromeDebugEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const version = await fetchChromeVersion(port)
    if (version !== null) return version
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return null
}

/**
 * 受限沙箱回退：Playwright 自己 spawn Chrome 会 EPERM/EACCES（CDP 需要管道），
 * 改由 PowerShell 的 Start-Process 拉起 Chrome，再用 connectOverCDP 走 TCP 连接。
 */
async function connectChromeOverCdp(chromium) {
  const port = Number(process.env.CHROME_CDP_PORT || 9333)
  let started = null
  if ((await fetchChromeVersion(port)) === null) {
    const chromePath = findChrome()
    const profile = path.join(os.tmpdir(), 'dsh-ann-perf-chrome-' + process.pid)
    mkdirSync(profile, { recursive: true })
    const chromeArgs = [
      '--headless=new',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--mute-audio',
      'about:blank',
    ]
    const command = 'Start-Process -FilePath ' + psQuote(chromePath)
      + ' -ArgumentList ' + psQuote(chromeArgs.map(quoteArgument).join(' '))
      + ' -WindowStyle Hidden | Out-Null'
    try {
      await runQuiet(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command])
    } catch (error) {
      throw new Error('启动 Chrome 失败（' + (error && error.code || error) + '）；'
        + '请手动执行: Start-Process ' + psQuote(chromePath) + ' -ArgumentList '
        + psQuote(chromeArgs.map(quoteArgument).join(' ')))
    }
    started = { profile }
  }
  const version = await waitForChromeDebugEndpoint(port, 20000)
  if (version === null) throw new Error('Chrome 调试端口 ' + port + ' 不可达')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  return {
    browser,
    connection: 'cdp',
    chromeVersion: version.Browser || browser.version(),
    close: async () => {
      await browser.close().catch(() => {})
      if (started !== null) {
        const stop = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'"'
          + ' | Where-Object { $_.CommandLine -like ' + psQuote('*' + started.profile + '*') + ' }'
          + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
        await runQuiet(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', stop]).catch(() => {})
      }
    },
  }
}

async function openBrowser(chromium) {
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: LAUNCH_ARGS })
    return {
      browser,
      connection: 'launch',
      chromeVersion: browser.version(),
      close: async () => { await browser.close().catch(() => {}) },
    }
  } catch (error) {
    const message = String((error && error.code) || (error && error.message) || error)
    if (!/EPERM|EACCES|spawn/i.test(message)) throw error
    console.warn('[perf] chromium.launch 被沙箱拒绝（' + message + '），回退到 PowerShell 启动 Chrome + connectOverCDP')
    return await connectChromeOverCdp(chromium)
  }
}

// ---------------------------------------------------------------- 页面 fixture

/** 贴近真实宿主结构：fixed 顶栏 + fixed 输入区 + 滚动容器（[data-conversation-scroll]，
 *  class 里带 CSS Modules local 名 _scrollBody）+ 内部内容层同样带 _scrollBody 后缀
 *  （hostLocalRects('scrollBody') 会同时命中两者，按文档顺序取第一个即滚动容器可视区）。 */
function buildFixture(rowCount, paragraphCount) {
  const rowsHtml = []
  for (let r = 0; r < rowCount; r++) {
    const paragraphs = []
    for (let p = 0; p < paragraphCount; p++) {
      paragraphs.push('<p>第 ' + (r + 1) + ' 行第 ' + (p + 1) + ' 段：用于批注性能基准的助手正文。</p>')
    }
    // data-chat-anchor-key 放在行上：captureAnchor 用它记录 seqKey（批注锚定）。
    rowsHtml.push('<div data-chat-flow-kind="assistant-step" data-chat-anchor-key="k' + (r + 1) + '">'
      + paragraphs.join('') + '</div>')
  }
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + '  * { box-sizing: border-box; }'
    + '  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #fafafa; }'
    + '  .wSkVaW_header { position: fixed; left: 0; top: 0; width: 100%; height: 56px; background: #e9e9e9; z-index: 30; }'
    + '  [data-conversation-scroll] { position: absolute; left: 200px; top: 56px; width: 640px; height: 564px;'
    + '    overflow-y: auto; overflow-x: hidden; background: #fff; }'
    + '  .wSkVaW_chatFlow { padding: 0 0 120px; }'
    // 内层内容层也带 _scrollBody 结尾的 class token（hostLocalRects('scrollBody') 会
    // 同时命中滚动容器与它，按文档顺序取第一个=滚动容器可视区）；样式不能复用
    // 滚动容器的绝对定位规则，否则会变成嵌套滚动容器、外层滚动距离只剩几十像素。
    + '  .wSkVaW_chatFlow.wSkVaW_scrollBody { position: static; overflow: visible; height: auto; }'
    + '  [data-chat-flow-kind="assistant-step"] { padding: 10px 24px 14px; }'
    + '  [data-chat-flow-kind="assistant-step"] + [data-chat-flow-kind="assistant-step"] { border-top: 1px solid #eee; }'
    + '  [data-chat-flow-kind="assistant-step"] p { margin: 0 0 8px; white-space: nowrap; }'
    + '  .wSkVaW_composerSeat { position: fixed; left: 200px; bottom: 0; width: 640px; height: 160px;'
    + '    background: #fff; border-top: 1px solid #ddd; z-index: 20; }'
    + '  [data-composer-card] { margin: 12px 24px; padding: 8px; border: 1px solid #ccc; border-radius: 8px; }'
    + '  [data-composer-input] { min-height: 60px; outline: none; }'
    + '</style></head><body>'
    + '<div class="wSkVaW_header" data-perf-header></div>'
    + '<div class="wSkVaW_composerSeat" data-composer-seat>'
    + '  <div data-composer-card><div data-composer-input contenteditable="true">待发送草稿</div></div>'
    + '</div>'
    + '<div class="wSkVaW_scrollBody" data-conversation-scroll>'
    + '  <div class="wSkVaW_chatFlow wSkVaW_scrollBody" data-chat-flow>' + rowsHtml.join('') + '</div>'
    + '</div>'
    + '</body></html>'
}

// ---------------------------------------------------------------- 页面探针（addInitScript）

/** 在 document 创建前包装 rAF 并注册 longtask 观察器。
 *  插件 client.js 用裸 requestAnimationFrame，因此会走这层包装。
 *  同时 monkey-patch Document.prototype.querySelectorAll 统计「全文档查询」次数：
 *  旧实现把 hostLocalRects('scrollBody'/'header'/'composerSeat') 放在每条批注的
 *  循环里，滚动时每帧 O(N) 次全文档查询；新实现缓存宿主元素后应降到 0。 */
function installPerfProbes() {
  const original = window.requestAnimationFrame.bind(window)
  const perf = {
    original,
    callbacks: [],
    longTasks: [],
    querySelectorAll: { total: 0, bySelector: Object.create(null) },
  }
  window.__perf = perf
  window.requestAnimationFrame = function (callback) {
    return original(function (timestamp) {
      const start = performance.now()
      try { callback(timestamp) } finally { perf.callbacks.push({ start, end: performance.now() }) }
    })
  }
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) perf.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch (_) { /* 老版本浏览器没有 longtask */ }
  try {
    const originalQuerySelectorAll = Document.prototype.querySelectorAll
    Document.prototype.querySelectorAll = function (selector) {
      const counters = window.__perf ? window.__perf.querySelectorAll : null
      if (counters !== null) {
        counters.total++
        const key = String(selector).slice(0, 80)
        counters.bySelector[key] = (counters.bySelector[key] || 0) + 1
      }
      return originalQuerySelectorAll.apply(this, arguments)
    }
  } catch (_) { /* 统计失败不影响测量 */ }
}

// ---------------------------------------------------------------- 页面搭建 / 交互

async function bootPage(context, clientPath) {
  const page = await context.newPage()
  await page.setViewportSize(VIEWPORT)
  page.setDefaultTimeout(15000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push('console.error: ' + message.text())
  })
  await page.addInitScript(installPerfProbes)
  await page.route(PAGE_URL, route => route.fulfill({ contentType: 'text/html', body: buildFixture(rows, PARAGRAPHS_PER_ROW) }))
  await page.goto(PAGE_URL)
  // 同一 context（CDP 模式）下 localStorage 跨页面共享，先清掉上一规模的待发送批注，
  // 保证每个 N 都从零生成（pending 只影响 ui.quotes 的初始值）。
  await page.evaluate(() => { try { localStorage.clear() } catch (_) { /* about:blank 之外才有 */ } })
  await page.evaluate(() => {
    window.__perfRun = { quotes: [] }
    window.__ModuleLoader__ = { load(entry) { window.api = entry.factory(() => ({})) } }
  })
  await page.addScriptTag({ path: clientPath })
  await page.evaluate(() => {
    window.dispose = window.api.apply({
      sessions: {
        list: { getSnapshot: () => ({ current: 'session' }), subscribe: () => () => {} },
        scope: () => ({ sessionId: 'session' }),
      },
      conversation: {
        input: { for: () => ({ state: { getSnapshot: () => ({ draft: '' }) }, setDraft: () => {} }) },
      },
      locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
      get: () => undefined,
    })
  })
  // kickDecorate / watchInputDraft 的首轮异步工作在测量前完成。
  await page.waitForTimeout(300)
  return { page, pageErrors }
}

function quoteTargets(total, rowCount, paragraphCount) {
  const targets = []
  for (let i = 0; i < total; i++) {
    // 前 rowCount 条一行一条；超过行数后回填到每行第 2 段（文本仍唯一）。
    targets.push({ row: i % rowCount, paragraph: i < rowCount ? 0 : Math.min(paragraphCount - 1, 1) })
  }
  return targets
}

/** 用真实交互生成 N 条批注：滚动到目标行 → Range + selectionchange → 工具条 →
 *  填批注 → 保存，并校验 .dsh-ann-hl/.dsh-ann-num 确实出现。 */
async function addAnnotations(page, total) {
  const warnings = []
  const targets = quoteTargets(total, rows, PARAGRAPHS_PER_ROW)
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    // 滚到目标行并取段落中心：先用真实鼠标点一下正文，把焦点从 [data-composer-input]
    // 收回来（保存批注后 focusComposer 会把焦点还回 contenteditable；焦点留在
    // 可编辑区时 Chrome 会把 document selection 收回编辑区，250ms settle 会失效）。
    const paragraphPoint = await page.evaluate(({ rowIndex, paragraphIndex }) => {
      const row = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')[rowIndex]
      row.scrollIntoView({ block: 'center' })
      const paragraph = row.querySelectorAll('p')[paragraphIndex]
      const rect = paragraph.getBoundingClientRect()
      return { x: rect.left + 6, y: rect.top + rect.height / 2 }
    }, { rowIndex: target.row, paragraphIndex: target.paragraph })
    await page.waitForTimeout(80)
    await page.mouse.click(paragraphPoint.x, paragraphPoint.y)
    await page.waitForTimeout(30)
    const selectedText = await page.evaluate(({ rowIndex, paragraphIndex }) => {
      const row = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')[rowIndex]
      const paragraph = row.querySelectorAll('p')[paragraphIndex]
      const textNode = paragraph.firstChild
      const range = document.createRange()
      // 用文本节点级 range（等价于用户拖选文字），端点稳定不会被浏览器规范化改写。
      range.setStart(textNode, 0)
      range.setEnd(textNode, textNode.nodeValue.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      // 原生 selectionchange 是异步派发的，主动派发让 250ms settle 立刻排上。
      document.dispatchEvent(new Event('selectionchange'))
      return paragraph.textContent
    }, { rowIndex: target.row, paragraphIndex: target.paragraph })

    const bar = page.locator('.dsh-ann-bar')
    try {
      await bar.waitFor({ state: 'attached' })
    } catch (error) {
      const snapshot = await page.evaluate(() => ({
        selection: window.getSelection() ? window.getSelection().toString().slice(0, 40) : '',
        hostChildren: document.querySelector('[data-annotation-for-dsh]')
          ? document.querySelector('[data-annotation-for-dsh]').childNodes.length : -1,
        bars: document.querySelectorAll('.dsh-ann-bar').length,
        cards: document.querySelectorAll('.dsh-ann-card').length,
        perfProbe: typeof window.__perf,
      })).catch(() => ({}))
      throw new Error('第 ' + (i + 1) + ' 条批注：.dsh-ann-bar 未出现；状态='
        + JSON.stringify(snapshot) + '；' + error.message)
    }
    await bar.locator('button').first().click()
    await page.locator('.dsh-ann-input').fill('性能基准批注 ' + (i + 1))
    const numbersBefore = await page.locator('.dsh-ann-num').count()
    await page.locator('.dsh-ann-action').click()
    await page.waitForFunction(expected => document.querySelectorAll('.dsh-ann-hl').length >= expected, i + 1)
    const highlightCount = await page.locator('.dsh-ann-hl').count()
    const numbersAfter = await page.locator('.dsh-ann-num').count()
    if (highlightCount !== i + 1) {
      warnings.push('第 ' + (i + 1) + ' 条批注保存后 .dsh-ann-hl=' + highlightCount + '（期望 ' + (i + 1) + '）')
    }
    if (numbersAfter <= numbersBefore) {
      warnings.push('第 ' + (i + 1) + ' 条批注的编号没有出现（' + numbersBefore + ' -> ' + numbersAfter + '）')
    }
    await page.evaluate(entry => { window.__perfRun.quotes.push(entry) }, {
      row: target.row,
      paragraph: target.paragraph,
      text: selectedText,
      note: '性能基准批注 ' + (i + 1),
    })
  }
  return { warnings, targets }
}

async function countsOf(page) {
  return await page.evaluate(() => ({
    quotes: window.__perfRun.quotes.length,
    highlights: document.querySelectorAll('.dsh-ann-hl').length,
    numbers: document.querySelectorAll('.dsh-ann-num').length,
    pendingStored: (() => {
      try {
        const keys = Object.keys(localStorage).filter(key => key.indexOf('dsh.annotation.pending') !== -1)
        let total = 0
        for (const key of keys) total += JSON.parse(localStorage.getItem(key) || '[]').length
        return total
      } catch (_) { return null }
    })(),
  }))
}

/** 预滚一次作为 warm-up（同时把测量轮要用的 Range 预热）。 */
async function warmupScroll(page) {
  await page.evaluate(async ({ frames }) => {
    const raf = window.__perf.original
    const nextFrame = () => new Promise(resolve => raf(resolve))
    const scroller = document.querySelector('[data-conversation-scroll]')
    scroller.scrollTop = 0
    await nextFrame(); await nextFrame()
    const total = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const step = total / frames
    let position = 0
    await new Promise(resolve => {
      let index = 0
      const tick = () => {
        position = Math.min(position + step, total)
        scroller.scrollTop = position
        index++
        if (index >= frames) { resolve(); return }
        raf(tick)
      }
      raf(tick)
    })
  }, { frames: scrollFrames })
  await page.waitForTimeout(300)
}

// ---------------------------------------------------------------- 主测量

/** 滚动一轮（不读 DOM），统计帧间隔 / 插件 rAF 耗时 / longtask / DOM 重建 / 停止后收敛。 */
async function measureScrollPerf(page) {
  return await page.evaluate(async ({ frames }) => {
    const round = (value, digits) => {
      if (!Number.isFinite(value)) return null
      const factor = Math.pow(10, digits === undefined ? 2 : digits)
      return Math.round(value * factor) / factor
    }
    const statsOf = values => {
      if (values.length === 0) return { count: 0, p50: null, p95: null, max: null, mean: null }
      const sorted = values.slice().sort((a, b) => a - b)
      const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
      return {
        count: sorted.length,
        p50: round(at(0.5)),
        p95: round(at(0.95)),
        max: round(sorted[sorted.length - 1]),
        mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
      }
    }
    const perf = window.__perf
    const raf = perf.original
    const nextFrame = () => new Promise(resolve => raf(resolve))
    const scroller = document.querySelector('[data-conversation-scroll]')
    const overlay = document.querySelector('[data-annotation-overlay]')
    const numLayer = document.querySelector('[data-annotation-num-layer]')
    if (overlay === null || numLayer === null) throw new Error('批注标记层不存在，插件没有完成初始化')

    // 预构建原文 Range（滚动中复用，避免每帧重新定位）。
    const messageRows = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
    const quoteRanges = window.__perfRun.quotes.map(entry => {
      const paragraph = messageRows[entry.row].querySelectorAll('p')[entry.paragraph]
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      return range
    })
    // 只比较「用户此刻真的能看到」的高亮：池化实现里视口外/被隐藏的标记
    // （display:none）与原文 Range 没有可比位置，跳过它们。
    const deviationOf = () => {
      const highlights = document.querySelectorAll('.dsh-ann-hl')
      const count = Math.min(highlights.length, quoteRanges.length)
      let max = 0
      let compared = 0
      for (let i = 0; i < count; i++) {
        const got = highlights[i].getBoundingClientRect()
        if (got.width === 0 || got.height === 0) continue
        if (got.bottom <= 0 || got.top >= window.innerHeight || got.right <= 0 || got.left >= window.innerWidth) continue
        const want = quoteRanges[i].getBoundingClientRect()
        const deviation = Math.max(Math.abs(got.top - want.top), Math.abs(got.left - want.left))
        if (deviation > max) max = deviation
        compared++
      }
      return { max, count: compared }
    }

    // 归零并等滚动事件 / 插件重建安静下来。
    scroller.scrollTop = 0
    await nextFrame(); await nextFrame(); await nextFrame()
    perf.callbacks.length = 0
    perf.longTasks.length = 0

    // DOM 重建观察器。
    const mutation = { batches: 0, childListRecords: 0, addedNodes: 0, overlayRecords: 0, numLayerRecords: 0 }
    let observing = true
    const accumulate = records => {
      let relevant = false
      for (const record of records) {
        if (record.type !== 'childList') continue
        relevant = true
        mutation.childListRecords++
        mutation.addedNodes += record.addedNodes.length
        if (record.target === overlay || overlay.contains(record.target)) mutation.overlayRecords++
        if (record.target === numLayer || numLayer.contains(record.target)) mutation.numLayerRecords++
      }
      if (relevant) mutation.batches++
    }
    const observer = new MutationObserver(records => { if (observing) accumulate(records) })
    observer.observe(overlay, { childList: true, subtree: true })
    observer.observe(numLayer, { childList: true, subtree: true })

    // 滚动驱动：覆盖整个内容高度，约 frames 帧；期间只写 scrollTop，不读 DOM。
    const total = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const step = total / frames
    const frameStamps = []
    let position = 0
    const scrollStartedAt = performance.now()
    await new Promise(resolve => {
      let index = 0
      const tick = timestamp => {
        frameStamps.push(timestamp)
        position = Math.min(position + step, total)
        scroller.scrollTop = position
        index++
        if (index >= frames) { resolve(); return }
        raf(tick)
      }
      raf(tick)
    })
    const scrollEndedAt = performance.now()

    // 滚动期间的全文档 querySelectorAll 次数（monkey-patch 统计）。必须在任何
    // 我们自己触发的 DOM 查询/读取之前取走——这里是滚动结束后的第一个语句。
    // 旧实现每条批注每帧都重新 hostLocalRects()，每帧次数 ≈ 3N + 常数。
    const querySelectorAllDuringScroll = {
      total: perf.querySelectorAll.total,
      bySelector: Object.assign({}, perf.querySelectorAll.bySelector),
    }
    perf.querySelectorAll.total = 0
    perf.querySelectorAll.bySelector = Object.create(null)

    // 滚动停止瞬间的偏差（此时 DOM 还是上一帧位置：最后一帧的 scroll 事件触发的
    // 重建还没落地，正好量化「滞后半拍」）。
    const firstDeviation = deviationOf()

    // 逐帧等标记追上原文；>1px 记为一帧滞后。
    const deviationSamples = [round(firstDeviation.max)]
    let framesToCatchUp = -1
    let settledDeviation = null
    for (let frame = 1; frame <= 30; frame++) {
      await nextFrame()
      const sample = deviationOf()
      deviationSamples.push(round(sample.max))
      if (sample.max <= 1) { framesToCatchUp = frame; settledDeviation = round(sample.max); break }
    }

    // 让最后一帧的重建与 MutationObserver 回调都落地，再取滚动期间的重建量。
    await nextFrame()
    observing = false
    accumulate(observer.takeRecords())
    observer.disconnect()
    const duringScroll = { ...mutation }

    const callbacks = perf.callbacks.slice()
    const longTasks = perf.longTasks.slice()
    const durations = callbacks.map(entry => entry.end - entry.start)
    const intervals = frameStamps.slice(1).map((stamp, index) => stamp - frameStamps[index])
    const addedPerFrame = round(duringScroll.addedNodes / frames)
    const recordsPerFrame = round(duringScroll.childListRecords / frames)

    return {
      frames: {
        count: frameStamps.length,
        scrollDistancePx: round(total),
        wallMs: round(scrollEndedAt - scrollStartedAt),
        intervalMs: statsOf(intervals),
      },
      rafCallbacks: {
        count: callbacks.length,
        perCallbackMs: statsOf(durations),
        totalMs: round(durations.reduce((sum, value) => sum + value, 0)),
        callbacksPerFrame: round(callbacks.length / frames),
      },
      longTasks: {
        count: longTasks.length,
        totalMs: round(longTasks.reduce((sum, entry) => sum + entry.duration, 0)),
        maxMs: round(longTasks.reduce((max, entry) => Math.max(max, entry.duration), 0)),
      },
      mutations: {
        duringScroll,
        recordsPerFrame,
        addedNodesPerFrame: addedPerFrame,
      },
      querySelectorAll: {
        duringScroll: querySelectorAllDuringScroll,
        perFrame: round(querySelectorAllDuringScroll.total / frames),
      },
      lag: {
        framesToCatchUp,
        firstFrameDeviationPx: round(firstDeviation.max),
        settledDeviationPx: settledDeviation,
        samplesPx: deviationSamples.slice(0, 8),
        measuredPairs: firstDeviation.count,
      },
      counts: {
        highlights: document.querySelectorAll('.dsh-ann-hl').length,
        numbers: document.querySelectorAll('.dsh-ann-num').length,
        quotes: window.__perfRun.quotes.length,
        scrollTopAtEnd: round(scroller.scrollTop),
      },
    }
  }, { frames: scrollFrames })
}

/** 观测轮：滚动中每帧测一次 .dsh-ann-hl 与原文 Range 的偏差（上一帧重建结果），
 *  用来确认「逐帧是否追上」。该轮读 DOM 会扰动帧耗时，只用于滞后定性。 */
async function measureLagDuringScroll(page) {
  return await page.evaluate(async ({ frames }) => {
    const round = (value, digits) => {
      if (!Number.isFinite(value)) return null
      const factor = Math.pow(10, digits === undefined ? 2 : digits)
      return Math.round(value * factor) / factor
    }
    const statsOf = values => {
      if (values.length === 0) return { count: 0, p50: null, p95: null, max: null, mean: null }
      const sorted = values.slice().sort((a, b) => a - b)
      const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
      return {
        count: sorted.length,
        p50: round(at(0.5)),
        p95: round(at(0.95)),
        max: round(sorted[sorted.length - 1]),
        mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
      }
    }
    const raf = window.__perf.original
    const nextFrame = () => new Promise(resolve => raf(resolve))
    const scroller = document.querySelector('[data-conversation-scroll]')
    const messageRows = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
    const quoteRanges = window.__perfRun.quotes.map(entry => {
      const paragraph = messageRows[entry.row].querySelectorAll('p')[entry.paragraph]
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      return range
    })
    // 只比较「用户此刻真的能看到」的高亮：池化实现里视口外/被隐藏的标记
    // （display:none）与原文 Range 没有可比位置，跳过它们。
    const deviationOf = () => {
      const highlights = document.querySelectorAll('.dsh-ann-hl')
      const count = Math.min(highlights.length, quoteRanges.length)
      let max = 0
      let compared = 0
      for (let i = 0; i < count; i++) {
        const got = highlights[i].getBoundingClientRect()
        if (got.width === 0 || got.height === 0) continue
        if (got.bottom <= 0 || got.top >= window.innerHeight || got.right <= 0 || got.left >= window.innerWidth) continue
        const want = quoteRanges[i].getBoundingClientRect()
        const deviation = Math.max(Math.abs(got.top - want.top), Math.abs(got.left - want.left))
        if (deviation > max) max = deviation
        compared++
      }
      return { max, count: compared }
    }

    scroller.scrollTop = 0
    await nextFrame(); await nextFrame(); await nextFrame()
    const total = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const step = total / frames
    // 每个 tick 在「上一帧插件重建之后、写新 scrollTop 之前」采样：理想为 0，
    // 出现明显偏差说明插件某一帧没跟上（重建滞后或漏帧）。
    const deviations = []
    const drift = { max: 0 }
    let position = 0
    await new Promise(resolve => {
      let index = 0
      const tick = () => {
        deviations.push(deviationOf().max)
        position = Math.min(position + step, total)
        scroller.scrollTop = position
        const actual = scroller.scrollTop
        const delta = Math.abs(actual - position)
        if (delta > drift.max) drift.max = delta
        index++
        if (index >= frames) { resolve(); return }
        raf(tick)
      }
      raf(tick)
    })
    const framesWithDeviation = deviations.filter(value => value > 1).length
    return {
      frames: deviations.length,
      deviationPx: statsOf(deviations),
      framesWithDeviation,
      scrollTopDriftMaxPx: round(drift.max),
      note: '观测轮每帧读 DOM 会扰动帧耗时，仅用于滞后定性',
    }
  }, { frames: scrollFrames })
}

// ---------------------------------------------------------------- 单个规模

async function runScale(browser, connection, n, clientPath) {
  const context = connection === 'launch'
    ? await browser.newContext({ viewport: VIEWPORT })
    : browser.contexts()[0]
  if (context === undefined) throw new Error('connectOverCDP 没有可用的 browser context')
  const { page, pageErrors } = await bootPage(context, clientPath)
  const startedAt = Date.now()
  try {
    const generated = await addAnnotations(page, n)
    const countsAfterSetup = await countsOf(page)
    if (countsAfterSetup.highlights !== n) {
      throw new Error('N=' + n + ' 只生成了 ' + countsAfterSetup.highlights + ' 个高亮（期望 ' + n + '）'
        + (generated.warnings.length > 0 ? '；' + generated.warnings.join('；') : ''))
    }
    await warmupScroll(page)
    const performance = await measureScrollPerf(page)
    const observedLag = await measureLagDuringScroll(page)
    const countsAfterScroll = await countsOf(page)
    return {
      n,
      setupMs: Date.now() - startedAt,
      countsAfterSetup,
      countsAfterScroll,
      scroll: performance,
      observedLag,
      warnings: generated.warnings,
      pageErrors,
    }
  } finally {
    await page.close().catch(() => {})
    if (connection === 'launch') await context.close().catch(() => {})
  }
}

// ---------------------------------------------------------------- 报告

function formatRunSummary(run) {
  const frames = run.scroll.frames.intervalMs
  const callbacks = run.scroll.rafCallbacks.perCallbackMs
  const mutations = run.scroll.mutations
  const lag = run.scroll.lag
  return [
    'N=' + String(run.n).padEnd(3),
    '帧间隔 p50=' + frames.p50 + 'ms p95=' + frames.p95 + 'ms max=' + frames.max + 'ms',
    '| 插件rAF p50=' + callbacks.p50 + 'ms p95=' + callbacks.p95 + 'ms max=' + callbacks.max + 'ms',
    '| longtask ' + run.scroll.longTasks.count + '次/共' + run.scroll.longTasks.totalMs + 'ms',
    '| 全文档qsA 每帧 ' + run.scroll.querySelectorAll.perFrame + '次',
    '| DOM重建 每帧 ' + mutations.recordsPerFrame + '条记录/' + mutations.addedNodesPerFrame + '节点'
      + '（共 ' + mutations.duringScroll.childListRecords + '条/' + mutations.duringScroll.addedNodes + '节点）',
    '| 滞后 停止后 ' + lag.framesToCatchUp + '帧 首帧偏差 ' + lag.firstFrameDeviationPx + 'px'
      + '（滚动中观测 p95=' + run.observedLag.deviationPx.p95 + 'px，偏差帧 ' + run.observedLag.framesWithDeviation + '）',
    '| 标记 hl=' + run.countsAfterScroll.highlights + ' num=' + run.countsAfterScroll.numbers,
  ].join(' ')
}

function clientInfo(filePath, name) {
  const source = readFileSync(filePath)
  const relative = path.relative(process.cwd(), filePath)
  return {
    name,
    path: relative.startsWith('..') ? filePath : relative.split(path.sep).join('/'),
    bytes: source.length,
    sha256: createHash('sha256').update(source).digest('hex'),
  }
}

function buildMeta(session, clients) {
  return {
    script: path.relative(process.cwd(), SCRIPT_PATH).split(path.sep).join('/'),
    generatedAt: new Date().toISOString(),
    variants: clients,
    runtime: {
      node: process.version,
      platform: process.platform + ' ' + process.arch,
      playwright: playwrightVersion(),
      chrome: session.chromeVersion,
      connection: session.connection,
      headless: true,
      viewport: VIEWPORT,
    },
    fixture: {
      rows,
      paragraphsPerRow: PARAGRAPHS_PER_ROW,
      scrollFrames,
      annotationFlow: 'Range + selectionchange -> .dsh-ann-bar button -> .dsh-ann-input fill -> .dsh-ann-action',
      structure: '[data-conversation-scroll]（overflow-y:auto，_scrollBody）内 [data-chat-flow] 的 '
        + rows + ' 行 [data-chat-flow-kind="assistant-step"]（data-chat-anchor-key=k1..k' + rows + '）；'
        + 'fixed ._header 顶栏；fixed ._composerSeat + [data-composer-card]/[data-composer-input]',
      metrics: {
        frameInterval: '驱动 rAF 时间戳差 p50/p95/max（ms）',
        rafCallback: 'addInitScript 包装 requestAnimationFrame 后每个回调执行耗时 p50/p95/max（ms），即插件 renderMarkers+updateChip 每帧主线程开销',
        longTasks: 'PerformanceObserver({entryTypes:[longtask]}) 条目数与总时长',
        querySelectorAll: 'monkey-patch Document.prototype.querySelectorAll 统计滚动期间全文档查询次数（每帧 = total/frames）',
        mutations: 'MutationObserver 观察 overlay/numLayer 子树 childList 记录数 + addedNodes 数（滚动期间）',
        lag: '滚动停止后 .dsh-ann-hl 与原文 Range 的 top/left 偏差（getBoundingClientRect）；观测轮逐帧偏差',
      },
    },
  }
}

function buildComparison(variants) {
  const names = Object.keys(variants)
  if (names.length < 2) return []
  const baseline = variants.baseline || variants[names[0]]
  const current = variants.current || variants[names[1]]
  const metric = (variant, n, pick) => {
    const run = variant.runs.find(entry => entry.n === n && !entry.error)
    return run === undefined ? null : pick(run)
  }
  const delta = (a, b) => (a === null || b === null ? null : Math.round((b - a) * 100) / 100)
  return nList.map(n => {
    const pick = (variant, selector) => {
      const run = variant.runs.find(entry => entry.n === n && !entry.error)
      return run === undefined ? null : selector(run)
    }
    return {
      n,
      baseline: {
        frameIntervalP50Ms: pick(baseline, run => run.scroll.frames.intervalMs.p50),
        rafCallbackP50Ms: pick(baseline, run => run.scroll.rafCallbacks.perCallbackMs.p50),
        rafCallbackP95Ms: pick(baseline, run => run.scroll.rafCallbacks.perCallbackMs.p95),
        longTaskCount: pick(baseline, run => run.scroll.longTasks.count),
        querySelectorAllPerFrame: pick(baseline, run => run.scroll.querySelectorAll.perFrame),
        mutationRecordsPerFrame: pick(baseline, run => run.scroll.mutations.recordsPerFrame),
        addedNodesPerFrame: pick(baseline, run => run.scroll.mutations.addedNodesPerFrame),
        framesToCatchUp: pick(baseline, run => run.scroll.lag.framesToCatchUp),
        firstFrameDeviationPx: pick(baseline, run => run.scroll.lag.firstFrameDeviationPx),
      },
      current: {
        frameIntervalP50Ms: pick(current, run => run.scroll.frames.intervalMs.p50),
        rafCallbackP50Ms: pick(current, run => run.scroll.rafCallbacks.perCallbackMs.p50),
        rafCallbackP95Ms: pick(current, run => run.scroll.rafCallbacks.perCallbackMs.p95),
        longTaskCount: pick(current, run => run.scroll.longTasks.count),
        querySelectorAllPerFrame: pick(current, run => run.scroll.querySelectorAll.perFrame),
        mutationRecordsPerFrame: pick(current, run => run.scroll.mutations.recordsPerFrame),
        addedNodesPerFrame: pick(current, run => run.scroll.mutations.addedNodesPerFrame),
        framesToCatchUp: pick(current, run => run.scroll.lag.framesToCatchUp),
        firstFrameDeviationPx: pick(current, run => run.scroll.lag.firstFrameDeviationPx),
      },
      delta: {
        rafCallbackP95Ms: delta(
          metric(baseline, n, run => run.scroll.rafCallbacks.perCallbackMs.p95),
          metric(current, n, run => run.scroll.rafCallbacks.perCallbackMs.p95)),
        querySelectorAllPerFrame: delta(
          metric(baseline, n, run => run.scroll.querySelectorAll.perFrame),
          metric(current, n, run => run.scroll.querySelectorAll.perFrame)),
        mutationRecordsPerFrame: delta(
          metric(baseline, n, run => run.scroll.mutations.recordsPerFrame),
          metric(current, n, run => run.scroll.mutations.recordsPerFrame)),
        addedNodesPerFrame: delta(
          metric(baseline, n, run => run.scroll.mutations.addedNodesPerFrame),
          metric(current, n, run => run.scroll.mutations.addedNodesPerFrame)),
      },
    }
  })
}

function printHumanSummary(report) {
  console.log('')
  console.log('DSH 批注标记层滚动性能基线（N=批注条数，每规模独立页面）')
  console.log('Chrome=' + report.meta.runtime.chrome + '  connection=' + report.meta.runtime.connection
    + '  viewport=' + VIEWPORT.width + 'x' + VIEWPORT.height + '  rows=' + rows + '  frames=' + scrollFrames)
  const order = ['baseline', 'current'].filter(name => report.variants[name] !== undefined)
  for (const name of order.concat(Object.keys(report.variants).filter(value => order.indexOf(value) === -1))) {
    const variant = report.variants[name]
    console.log('')
    console.log('== ' + name + ' == client sha256=' + variant.client.sha256.slice(0, 12) + '…  '
      + variant.client.bytes + ' bytes  (' + variant.client.path + ')')
    for (const run of variant.runs) {
      if (run.error !== undefined) console.log('  ' + run.error)
      else console.log('  ' + formatRunSummary(run))
    }
  }
  if (report.comparison.length > 0) {
    console.log('')
    console.log('== baseline → current 差值（负值=改善）==')
    for (const row of report.comparison) {
      const line = ['N=' + String(row.n).padEnd(3),
        '插件rAF p95 Δ=' + row.delta.rafCallbackP95Ms + 'ms',
        '| 全文档qsA/帧 Δ=' + row.delta.querySelectorAllPerFrame,
        '| mutation记录/帧 Δ=' + row.delta.mutationRecordsPerFrame,
        '| addedNodes/帧 Δ=' + row.delta.addedNodesPerFrame]
      console.log(line.join(' '))
    }
  }
  if (report.warnings.length > 0) {
    console.log('')
    for (const warning of report.warnings) console.log('WARN: ' + warning)
  }
}

// ---------------------------------------------------------------- 入口

async function main() {
  if (cli.help) { console.log(usage()); return }
  const plan = []
  if (variantsRequested !== 'baseline') plan.push({ name: 'current', clientPath: currentClientPath })
  if (variantsRequested !== 'current') {
    if (baselineClientPath === null) {
      throw new Error('PERF_VARIANTS 要求 baseline，但没有设置 BASE_SCRIPT（旧实现 client.js 路径）')
    }
    plan.push({ name: 'baseline', clientPath: baselineClientPath })
  }
  const { chromium } = await loadPlaywright()
  const session = await openBrowser(chromium)
  const clients = plan.map(variant => clientInfo(variant.clientPath, variant.name))
  const report = { meta: buildMeta(session, clients), variants: {}, comparison: [], warnings: [] }
  try {
    for (const variant of plan) {
      report.variants[variant.name] = { client: clientInfo(variant.clientPath, variant.name), runs: [] }
      for (const n of nList) {
        console.log('[perf] ' + variant.name + ' N=' + n + ' 生成批注并测量…')
        try {
          const run = await runScale(session.browser, session.connection, n, variant.clientPath)
          report.variants[variant.name].runs.push(run)
          if (run.warnings.length > 0) {
            report.warnings.push(...run.warnings.map(warning => variant.name + ' N=' + n + ': ' + warning))
          }
          if (run.pageErrors.length > 0) {
            report.warnings.push(...run.pageErrors.map(error => variant.name + ' N=' + n + ' 页面错误: ' + error))
          }
          console.log('[perf] ' + variant.name + ' ' + formatRunSummary(run))
        } catch (error) {
          report.variants[variant.name].runs.push({ n, error: String((error && error.stack) || error) })
          throw error
        }
      }
    }
  } finally {
    await session.close()
  }
  report.comparison = buildComparison(report.variants)
  printHumanSummary(report)
  const json = JSON.stringify(report, null, 2) + '\n'
  if (cli.out !== null) {
    writeFileSync(path.resolve(cli.out), json)
    console.log('')
    console.log('完整报告已写入 ' + path.resolve(cli.out))
  }
  if (cli.writeBaseline) {
    try {
      writeFileSync(BASELINE_PATH, json)
      console.log('')
      console.log('基线已写入 ' + path.relative(process.cwd(), BASELINE_PATH))
    } catch (error) {
      throw new Error('写 test/perf-baseline.json 失败（' + (error && error.code) + '）：'
        + '受限沙箱里命令进程通常无权写工作区，可改用 --out=<临时路径> 输出，'
        + '再用文件工具落盘到 test/perf-baseline.json')
    }
  }
  if (cli.json) {
    console.log('')
    console.log(json)
  }
}

await main()
