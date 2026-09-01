import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const verifier = fileURLToPath(new URL('./verify-built-package-invariants.mjs', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: {
  companion?: boolean
  invariantSource?: string
  invariantExport?: string
  runtimeChunk?: string
} = {}): { root: string; loaderUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-built-package-invariants-'))
  roots.push(root)
  const packageDir = join(root, 'packages/core/probe')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  const companion = options.companion ?? true
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-probe',
    type: 'module',
    files: companion ? ['lib/invariant.js'] : [],
    exports: companion ? {
      './invariant': {
        default: options.invariantExport ?? './lib/invariant.js',
      },
    } : {},
  }, null, 2)}\n`)
  if (companion) {
    writeFileSync(
      join(packageDir, 'lib/invariant.js'),
      options.invariantSource ?? "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
    )
  }
  if (options.runtimeChunk !== undefined) {
    writeFileSync(join(packageDir, 'lib/chunk.js'), options.runtimeChunk)
  }
  const loaderPath = join(root, 'loader.mjs')
  writeFileSync(loaderPath, 'export default class Loader { unwrapExports(value) { return value } }\n')
  return { root, loaderUrl: pathToFileURL(loaderPath).href }
}

function verify(root: string, loaderUrl: string) {
  return spawnSync(process.execPath, [
    verifier,
    '--packages-root', root,
    '--loader-url', loaderUrl,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
  })
}

describe('built package invariant verifier', () => {
  it('loads the staged compiled self-reference through plain Node and Loader normalization', () => {
    const { root, loaderUrl } = fixture()
    const result = verify(root, loaderUrl)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('1 compiled companion(s) passed plain-Node Loader checks')
  })

  it('accepts packages that do not publish a companion', () => {
    const { root, loaderUrl } = fixture({ companion: false })
    const result = verify(root, loaderUrl)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('0 compiled companion(s) passed plain-Node Loader checks')
  })

  it('rejects a default export and a broken invariant export map', () => {
    const withDefault = fixture({
      invariantSource: "export default {}\nexport const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
    })
    const defaultResult = verify(withDefault.root, withDefault.loaderUrl)
    expect(defaultResult.status).toBe(1)
    expect(defaultResult.stderr).toContain('companion has a default export')

    const brokenExport = fixture({ invariantExport: './lib/missing.js' })
    const exportResult = verify(brokenExport.root, brokenExport.loaderUrl)
    expect(exportResult.status).toBe(1)
    expect(exportResult.stderr).toContain('@deepseek-ai/dsh-probe')
  })

  it('rejects an invariant bundle that needs an unstaged runtime chunk', () => {
    const { root, loaderUrl } = fixture({
      invariantSource: "export * from './chunk.js'\n",
      runtimeChunk: "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
    })
    const result = verify(root, loaderUrl)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('chunk.js')
  })
})
