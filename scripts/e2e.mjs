#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, rmSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_ROOT = process.env.DSH_ROOT ?? resolve(process.env.HOME ?? '', '.dsh/source/current')
const DSH_BIN = process.env.DSH_BIN ?? join(DSH_ROOT, 'apps/cli/lib/bin.js')
const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const PORT = Number(arg('--port') ?? 3191)
const INSTALL = arg('--install') ?? 'link'
const fail = (message) => { console.error(`✗ ${message}`); process.exit(1) }
const findDshWebUrl = (output) => output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+(?:\/\?token=[A-Za-z0-9_-]+)?)/u)?.[1]

if (!['link', 'npm'].includes(INSTALL)) fail(`--install 仅允许 link | npm，收到 ${INSTALL}`)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`非法端口: ${PORT}`)
if (!existsSync(DSH_BIN)) fail(`DSH_BIN 不存在: ${DSH_BIN}`)
await new Promise((resolveProbe) => {
  const probe = createServer()
  probe.once('error', () => fail(`端口 ${PORT} 已被占用`))
  probe.listen(PORT, '127.0.0.1', () => probe.close(resolveProbe))
})

const DSH_HOME = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'dsh-annotation-e2e-'))
const env = { ...process.env, DSH_HOME }
const logPath = join(DSH_HOME, 'dsh-web.log')
let web = null
const stopWeb = () => {
  if (web === null) return
  try { process.kill(-web.pid, 'SIGTERM') } catch { /* already stopped */ }
  try { process.kill(web.pid, 'SIGTERM') } catch { /* already stopped */ }
  web = null
}
process.on('exit', () => {
  stopWeb()
  rmSync(DSH_HOME, { recursive: true, force: true })
})

try {
  const source = INSTALL === 'npm' ? '@changfenhuang/dsh-annotation' : `link:${REPO_ROOT}`
  const installed = spawnSync(DSH_BIN, ['plugin', '--profile', 'web', 'add', source], { env, stdio: 'inherit' })
  if (installed.status !== 0) fail('插件安装失败')

  const workspaceId = randomUUID()
  const now = new Date().toISOString()
  await mkdir(join(DSH_HOME, 'storages'), { recursive: true })
  await writeFile(join(DSH_HOME, 'storages/workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] },
    tables: { workspaces: { [workspaceId]: {
      path: REPO_ROOT, title: 'dsh-annotation-e2e', sessionIds: [], createdAt: now, updatedAt: now,
    } } },
  }, null, 2))

  const logStream = createWriteStream(logPath, { flags: 'a' })
  web = spawn(DSH_BIN, ['web', '--no-open', '--port', String(PORT)], {
    env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const capture = (chunk) => { logStream.write(chunk); output += chunk.toString() }
  web.stdout.on('data', capture)
  web.stderr.on('data', capture)

  let readyUrl
  for (let attempt = 0; attempt < 120; attempt++) {
    readyUrl = findDshWebUrl(output)
    if (readyUrl !== undefined || web.exitCode !== null) break
    await new Promise(resolveWait => setTimeout(resolveWait, 1000))
  }
  if (readyUrl === undefined) fail(`dsh web 120 秒内未就绪（日志: ${logPath}）`)

  const { chromium } = await import(pathToFileURL(join(DSH_ROOT, 'apps/web/node_modules/playwright/index.mjs')).href)
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  await page.goto(readyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)

  const state = await page.evaluate(() => {
    const entries = window.__DSH_BOOT__?.entries
    return {
      clientUrl: Array.isArray(entries)
        ? entries.find(entry => entry.id === '@changfenhuang/dsh-annotation')?.url
        : undefined,
      mounted: document.querySelector('[data-annotation-for-dsh]') !== null,
    }
  })
  const clientUrl = state.clientUrl ?? '/plugins/@changfenhuang/dsh-annotation/client.js'
  const response = await fetch(`http://127.0.0.1:${PORT}${clientUrl}`)
  if (!response.ok) fail(`Annotation bundle 返回 ${response.status}`)
  if (!state.mounted) fail('Annotation bundle 已加载，但页面没有挂载批注入口')
  if (pageErrors.length > 0) fail(`页面异常: ${pageErrors.slice(0, 3).join(' | ')}`)

  await browser.close()
  stopWeb()
  await rm(DSH_HOME, { recursive: true, force: true })
  console.log('PASS Annotation smoke e2e')
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error))
}
