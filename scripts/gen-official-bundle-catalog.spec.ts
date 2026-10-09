/** Offline Official catalog ownership, completeness, and freshness checks. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ON_DEMAND_BUNDLES } from '../packages/boot/app-boot/src/official-bundles.ts'
import { generateOfficialBundleCatalog, renderOfficialBundleCatalog, syncOfficialBundleCatalog } from './gen-official-bundle-catalog.ts'

const roots: string[] = []
const output = 'packages/boot/app-boot/src/official-bundles.generated.ts'

function write(root: string, path: string, content: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof content === 'string' ? content : `${JSON.stringify(content)}\n`)
}

function directory(name: string): string { return `packages/subagent/${name.slice('@deepseek-ai/dsh-'.length)}` }

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-official-catalog-'))
  roots.push(root)
  write(root, 'apps/cli/package.json', { name: '@deepseek-ai/dsh' })
  for (const name of ON_DEMAND_BUNDLES) {
    const dir = directory(name)
    write(root, `${dir}/package.json`, {
      name, type: 'module', version: '1.2.3', icon: './icon.svg', dsh: { bundle: { patch: './cordis.patch.yml' } },
      exports: { '.': './must-not-run.js', './package.json': './package.json', './locale/*.json': './locale/*.json' },
    })
    write(root, `${dir}/must-not-run.js`, "throw new Error('metadata must not evaluate a provider')")
    write(root, `${dir}/icon.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    write(root, `${dir}/locale/en.json`, { meta: { title: 'Native agent', description: 'Delegate a task.' } })
    write(root, `${dir}/locale/zh.json`, { meta: { title: '原生智能体', description: '委派任务。' } })
  }
  write(root, output, '')
  return root
}

function updateManifest(root: string, name: string, changes: Record<string, unknown>): void {
  const path = `${directory(name)}/package.json`
  const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>
  write(root, path, { ...manifest, ...changes })
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Official bundle catalog generation', () => {
  it('reads package resources without evaluating native provider entries or pinning a version', () => {
    const entries = generateOfficialBundleCatalog(fixture())
    expect(entries.map(entry => entry.packageName)).toEqual(ON_DEMAND_BUNDLES)
    expect(entries[0]?.meta).toEqual({
      title: { en: 'Native agent', zh: '原生智能体' }, description: { en: 'Delegate a task.', zh: '委派任务。' },
      icon: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    })
    expect(renderOfficialBundleCatalog(entries)).not.toContain('1.2.3')
  })

  it.each(['private', 'not-bundle', 'missing', 'duplicate'])('rejects %s catalog membership', (kind) => {
    const root = fixture()
    const name = ON_DEMAND_BUNDLES[0]!
    if (kind === 'private') updateManifest(root, name, { private: true })
    if (kind === 'not-bundle') updateManifest(root, name, { dsh: {} })
    if (kind === 'missing') rmSync(join(root, directory(name)), { recursive: true })
    if (kind === 'duplicate') write(root, 'packages/subagent/duplicate/package.json', { name })
    expect(() => generateOfficialBundleCatalog(root)).toThrow(/public DSH bundle|duplicate workspace/)
  })

  it.each([false, true])('rejects an on-demand provider in the installed dependency closure (indirect=%s)', (indirect) => {
    const root = fixture()
    const name = ON_DEMAND_BUNDLES[0]!
    write(root, 'apps/cli/package.json', { name: '@deepseek-ai/dsh', dependencies: { [indirect ? '@deepseek-ai/dsh-layer' : name]: '*' } })
    if (indirect) write(root, 'packages/bundle/layer/package.json', { name: '@deepseek-ai/dsh-layer', dependencies: { [name]: '*' } })
    expect(() => generateOfficialBundleCatalog(root)).toThrow('must not be installed by the DSH distribution')
  })

  it('requires distinct nonempty catalog admission', () => {
    const root = fixture()
    expect(() => generateOfficialBundleCatalog(root, [])).toThrow('distinct package names')
    expect(() => generateOfficialBundleCatalog(root, [ON_DEMAND_BUNDLES[0]!, ON_DEMAND_BUNDLES[0]!])).toThrow('distinct package names')
  })

  it.each(['icon', 'en', 'zh'])('rejects missing %s metadata', (resource) => {
    const root = fixture()
    const dir = directory(ON_DEMAND_BUNDLES[0]!)
    rmSync(join(root, dir, resource === 'icon' ? 'icon.svg' : `locale/${resource}.json`))
    expect(() => generateOfficialBundleCatalog(root)).toThrow()
  })

  it.each(['en', 'zh'])('requires explicit %s fields instead of metadata fallback text', (language) => {
    const root = fixture()
    write(root, `${directory(ON_DEMAND_BUNDLES[0]!)}/locale/${language}.json`, { meta: { description: 'Only a description.' } })
    expect(() => generateOfficialBundleCatalog(root)).toThrow(`explicit ${language} title and description`)
  })

  it('rejects stale output when package-owned display text changes', () => {
    const root = fixture()
    rmSync(join(root, output))
    syncOfficialBundleCatalog(root, false)
    expect(() => { syncOfficialBundleCatalog(root, true) }).not.toThrow()
    write(root, `${directory(ON_DEMAND_BUNDLES[0]!)}/locale/en.json`, { meta: { title: 'Changed', description: 'Delegate a task.' } })
    const before = readFileSync(join(root, output), 'utf8')
    expect(() => { syncOfficialBundleCatalog(root, true) }).toThrow('is stale')
    expect(readFileSync(join(root, output), 'utf8')).toBe(before)
    syncOfficialBundleCatalog(root, false)
    expect(readFileSync(join(root, output), 'utf8')).toContain('Changed')
  })

  it('does not rewrite an already current catalog during explicit generation', () => {
    const root = fixture()
    syncOfficialBundleCatalog(root, false)
    const path = join(root, output)
    const timestamp = new Date('2000-01-01T00:00:00Z')
    utimesSync(path, timestamp, timestamp)
    const before = statSync(path).mtimeMs
    syncOfficialBundleCatalog(root, false)
    expect(statSync(path).mtimeMs).toBe(before)
    expect(() => { syncOfficialBundleCatalog(root, true) }).not.toThrow()
  })

  it('rejects a missing generated catalog without recreating it during freshness checking', () => {
    const root = fixture()
    rmSync(join(root, output))
    expect(() => { syncOfficialBundleCatalog(root, true) }).toThrow('is stale')
    expect(existsSync(join(root, output))).toBe(false)
  })
})
