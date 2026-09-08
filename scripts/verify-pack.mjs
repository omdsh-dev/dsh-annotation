import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'annotation-pack-'))
execFileSync('npm', ['run', 'check'], { stdio: 'inherit' })
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir, '--json'], { encoding: 'utf8' }))
const paths = new Set(pack.files.map(file => file.path))
for (const path of ['package.json', 'client.js', 'lib/index.js', 'lib/types/index.d.ts', 'src/index.ts', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md']) {
  assert.ok(paths.has(path), `Missing package entry: ${path}`)
}
const tarball = join(dir, pack.filename)
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const output = `tarball=${tarball}\nsha256=${sha256}\n`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
console.log(output)
