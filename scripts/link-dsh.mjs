#!/usr/bin/env node
/**
 * Link the @deepseek-ai peer packages this plugin compiles against into
 * node_modules. The @deepseek-ai/* packages are private (never on the public
 * registry), so the machine resolves them from the local DSH snapshot
 * checkout. This script creates node_modules/@deepseek-ai/* directory
 * symlinks pointing at the checkout's package directories; TypeScript and
 * tsdown then resolve types and (for externals, only at type level) the
 * package names through the loader module table at runtime.
 *
 * The DSH checkout is located via $DSH_SOURCE, falling back to the machine's
 * staging snapshot, then the annotation worktree.
 *
 * Run after `pnpm install` (pnpm rewrites node_modules). Never committed:
 * node_modules is gitignored.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const candidates = [
  process.env.DSH_SOURCE,
  '/Users/changfenhuang/.dsh/source/ann2-worktree',
  '/Users/changfenhuang/.dsh/source/staging-20260811T152241Z',
].filter(Boolean)

const checkout = candidates.find((candidate) => existsSync(join(candidate, 'packages')))

/** @deepseek-ai peer packages → their checkout-relative package dirs. */
const LINKS = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-client-locale': 'packages/client/locale',
  '@deepseek-ai/dsh-client-runtime': 'packages/client/runtime',
  '@deepseek-ai/dsh-client-ui-conversation': 'packages/client/ui-conversation',
  '@deepseek-ai/dsh-client-ui-primitives': 'packages/client/ui-primitives',
  '@deepseek-ai/dsh-client-ui-slash': 'packages/client/ui-slash',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  '@deepseek-ai/dsh-client-web-react': 'packages/client/web-react',
  '@deepseek-ai/dsh-host-apiproxy': 'packages/host/apiproxy',
}

if (checkout === undefined) {
  console.error('link-dsh: no DSH checkout found (set DSH_SOURCE)')
  process.exit(1)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scope = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(scope, { recursive: true })

for (const [name, relative] of Object.entries(LINKS)) {
  const target = resolve(checkout, relative)
  const link = join(scope, name.slice('@deepseek-ai/'.length))
  if (!existsSync(target)) {
    console.error(`link-dsh: ${target} missing — cannot link ${name}`)
    process.exit(1)
  }
  if (existsSync(link)) rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, 'dir')
  console.log(`linked ${name} → ${target}`)
}
console.log(`link-dsh: ${Object.keys(LINKS).length} links from ${checkout}`)
