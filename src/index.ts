// dsh-annotation 的 Node half：为「快捷批注标签」提供持久化读写。
// 标签存放在 DSH home 下的独立 JSON 文件（默认 dsh-annotation-tags.json，
// 可用插件 config.tagsFile 覆盖），浏览器端通过 GET/POST /annotation-tags 访问。
// 默认 Yes / No 不落盘：无文件 = 默认且不创建文件，用户增删后才写，回到默认则删文件。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-annotation'

/** 没有持久化数据时的默认标签（内置、不落盘）。 */
export const DEFAULT_TAGS = ['Yes', 'No']
/** 浏览器端读写的路由（同源相对路径 /annotation-tags）。 */
export const ROUTE_PATH = '/annotation-tags'

const TAG_LIMIT = 24
const TAG_LENGTH_LIMIT = 24
const BODY_LIMIT = 4096
const FILE_NAME = 'dsh-annotation-tags.json'

type TagList = string[]

function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** 标签 JSON 文件路径：config.tagsFile 显式优先，否则 DSH home 下的固定文件名。 */
export function resolveTagsFile(config: unknown): string {
  const explicit = (config as { tagsFile?: unknown } | null | undefined)?.tagsFile
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return join(dshHome(), FILE_NAME)
}

/** 规整标签列表：去空白、去重、限长限量；非数组返回 null（= 没有持久化数据）。 */
export function normalizeTags(value: unknown): TagList | null {
  if (!Array.isArray(value)) return null
  const out: TagList = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, TAG_LENGTH_LIMIT)
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= TAG_LIMIT) break
  }
  return out
}

/** 读标签文件：不存在 / 损坏时返回 null（调用方回落到内置默认，不创建文件）。 */
export function readTagsFile(file: string): TagList | null {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch (_) { return null }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return normalizeTags(parsed)
    if (parsed !== null && typeof parsed === 'object') {
      return normalizeTags((parsed as { tags?: unknown }).tags)
    }
    return null
  } catch (_) {
    return null
  }
}

function sameAsDefault(tags: TagList): boolean {
  if (tags.length !== DEFAULT_TAGS.length) return false
  for (let i = 0; i < DEFAULT_TAGS.length; i++) {
    if (tags[i] !== DEFAULT_TAGS[i]) return false
  }
  return true
}

/** 写标签文件：回到默认列表时删除文件（默认标签不落盘），否则写可读 JSON。 */
export function writeTagsFile(file: string, tags: TagList): void {
  if (sameAsDefault(tags)) {
    if (existsSync(file)) rmSync(file, { force: true })
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ tags }, null, 2) + '\n', 'utf8')
}

function sendJson(res: any, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function apply(ctx: any, config: unknown): void {
  let tagsFile: string | null = null
  try { tagsFile = resolveTagsFile(config) } catch (_) { tagsFile = null }

  // 文件不存在 = 内置默认；文件损坏也回落到默认（不覆盖用户文件）。
  let tags: TagList = (tagsFile !== null ? readTagsFile(tagsFile) : null) ?? DEFAULT_TAGS.slice()

  function persist(next: TagList): void {
    if (tagsFile === null) throw new Error('annotation tags file path unavailable')
    writeTagsFile(tagsFile, next)
    tags = next
  }

  const route = {
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req: any, res: any): void => {
      if (req.method === 'GET') {
        sendJson(res, 200, { tags })
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end()
        return
      }
      // 同源校验：这个本地路由能改动标签文件，拒绝跨站表单/脚本写入。
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
        let sameOrigin = false
        try { sameOrigin = new URL(origin).host === req.headers.host } catch (_) { sameOrigin = false }
        if (!sameOrigin) {
          sendJson(res, 403, { error: 'origin' })
          return
        }
      }
      let body = ''
      let finished = false
      req.on('data', (chunk: { toString: () => string }) => {
        if (finished) return
        body += chunk.toString()
        if (body.length > BODY_LIMIT) {
          finished = true
          sendJson(res, 413, { error: 'too-large' })
        }
      })
      req.on('end', () => {
        if (finished) return
        finished = true
        let payload: any
        try { payload = JSON.parse(body) } catch (_) {
          sendJson(res, 400, { error: 'bad-json' })
          return
        }
        if (payload === null || typeof payload !== 'object') {
          sendJson(res, 400, { error: 'bad-json' })
          return
        }
        if (payload.action !== 'add' && payload.action !== 'remove') {
          sendJson(res, 400, { error: 'bad-action' })
          return
        }
        if (typeof payload.tag !== 'string') {
          sendJson(res, 400, { error: 'bad-tag' })
          return
        }
        const tag = payload.tag.trim().slice(0, TAG_LENGTH_LIMIT)
        if (tag === '') {
          sendJson(res, 400, { error: 'bad-tag' })
          return
        }
        if (payload.action === 'add') {
          if (tags.includes(tag)) {
            sendJson(res, 200, { tags })
            return
          }
          if (tags.length >= TAG_LIMIT) {
            sendJson(res, 400, { error: 'too-many' })
            return
          }
        }
        const next = payload.action === 'add' ? tags.concat([tag]) : tags.filter((t) => t !== tag)
        try { persist(next) } catch (err) {
          sendJson(res, 500, { error: String((err as Error)?.message ?? err) })
          return
        }
        sendJson(res, 200, { tags })
      })
    },
  }

  // cordis 未声明依赖时禁止直读服务属性（ctx.webServer 会抛 without inject）；
  // 用 ctx.inject 声明可选依赖，webServer 可用时才注册路由，headless 下照常加载。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub: any) => {
      const webServer = sub.webServer
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
      sub.effect(() => webServer.register(route), 'dsh-annotation: tag store')
    })
    return
  }
  // 极旧 cordis 兜底：ctx.get 不触发 inject 检查，读不到就安静降级。
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
  if (typeof ctx.effect === 'function') ctx.effect(() => webServer.register(route), 'dsh-annotation: tag store')
  else webServer.register(route)
}

export default { name, apply }
