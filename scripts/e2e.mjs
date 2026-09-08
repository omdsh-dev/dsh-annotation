#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs'
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
const LIVE = process.argv.includes('--live')
const TARBALL = arg('--tarball')
const TARBALL_SHA = arg('--tarball-sha256')
const fail = (message) => { console.error(`✗ ${message}`); process.exit(1) }
const findDshWebUrl = (output) => output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+(?:\/\?token=[A-Za-z0-9_-]+)?)/u)?.[1]

if (!['link', 'npm', 'tarball'].includes(INSTALL)) fail(`未知安装方式 ${INSTALL}`)
if (INSTALL === 'tarball' && (!TARBALL || !TARBALL_SHA || createHash('sha256').update(readFileSync(TARBALL)).digest('hex') !== TARBALL_SHA)) fail('安装包 SHA-256 不匹配')
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`非法端口: ${PORT}`)
if (LIVE && !process.env.DEEPSEEK_API_KEY) fail('--live 需要真实模型凭据')
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
let browser = null
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
  const source = INSTALL === 'tarball' ? TARBALL : INSTALL === 'npm' ? '@changfenhuang/dsh-annotation' : `link:${REPO_ROOT}`
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
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ locale: 'zh-CN' })
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

  await page.getByRole('button', { name: '继续', exact: true }).click()
  if (!LIVE) await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  await page.getByText('新会话', { exact: false }).first().click()
  await page.getByText('dsh-annotation-e2e', { exact: true }).first().click()
  const composer = page.locator('[data-composer-input]')
  await composer.waitFor({ state: 'visible' })
  // Deterministic source passage; selection, composer, session and persistence are real host services.
  await page.evaluate(() => {
    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-kind', 'assistant-step')
    const passage = document.createElement('p')
    passage.id = 'annotation-smoke-source'
    passage.textContent = '这是一段用于验证批注的原文。'
    row.appendChild(passage)
    document.body.appendChild(row)
    const range = document.createRange()
    range.selectNodeContents(passage)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })
  await page.locator('.dsh-ann-bar button').click()
  await page.locator('.dsh-ann-input').fill('请解释这一句')
  await page.locator('.dsh-ann-action').click()
  await page.locator('[data-annotation-chip]').waitFor({ state: 'visible' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-annotation-chip]').waitFor({ state: 'visible' })
  if (pageErrors.length > 0) throw new Error(`交互异常: ${pageErrors.join(' | ')}`)
  console.log('PASS 真实宿主选区、保存和刷新恢复')
  if (LIVE) {
    await composer.press('Enter')
    const tag = page.locator('[data-annotation-bubble-tag]').filter({ hasText: '批注 ×1' })
    await tag.waitFor({ state: 'visible' })
    if ((await composer.textContent()).trim() !== '') fail('发送后草稿未清空')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await tag.waitFor({ state: 'visible' })
    await tag.hover()
    await page.waitForFunction(() => document.querySelector('.dsh-ann-tip')?.textContent.includes('请解释这一句'))
    if (pageErrors.length > 0) fail(`交互异常: ${pageErrors.join(' | ')}`)
    console.log('PASS 真实宿主选区、保存、刷新恢复、纯批注发送和历史标签')
  }

  await browser.close()
  stopWeb()
  await rm(DSH_HOME, { recursive: true, force: true })
  console.log('PASS Annotation smoke e2e')
} catch (error) {
  await browser?.close()
  fail(error instanceof Error ? error.stack ?? error.message : String(error))
}
