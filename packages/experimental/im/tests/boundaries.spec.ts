/**
 * Package-boundary guard: the platform adapter packages are vendor-tier leaves. A `packages/**` module reaches a
 * platform only through the Satori contracts, never by importing an adapter. Only `packages/experimental/im-bundle` mounts the
 * adapters in its composition.
 */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

/**
 * One adapter package specifier. Assembled from parts rather than written out, because the sibling guard in
 * `types.spec.ts` rejects that package-name pattern anywhere in this package, this guard included.
 */
const ADAPTER_SPECIFIER = new RegExp(`${['@deepseek-ai', 'cordis-plugin-im-adapter'].join('/')}-[a-z0-9-]+`)

/** The only package directory allowed to name an adapter: the shipped composition bundle. */
const ALLOWED_PREFIXES = ['packages/experimental/im-bundle/']

/** One import, re-export or dynamic import, capturing its module specifier. */
const IMPORT_STATEMENT = /\b(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"`]([^'"`]+)['"`]/u

interface Violation {
  file: string
  specifier: string
}

interface Scan {
  /** One violation per offending statement outside the allowed prefixes. */
  violations: Violation[]
  /** Source files scanned under `packages/**`. */
  scanned: number
}

let cached: Scan | undefined

/**
 * Scan every TypeScript module of every package once.
 * @returns the violations outside the allowed prefixes and the count of scanned files.
 */
function scan(): Scan {
  if (cached !== undefined) return cached
  const violations: Violation[] = []
  const files = globSync('packages/**/src/**/*.ts', { cwd: root })
    .map(entry => entry.split('\\').join('/'))
    .sort()
  for (const file of files) {
    if (ALLOWED_PREFIXES.some(prefix => file.startsWith(prefix))) continue
    const text = readFileSync(resolve(root, file), 'utf8')
    if (!ADAPTER_SPECIFIER.test(text)) continue
    for (const line of text.split('\n')) {
      const specifier = IMPORT_STATEMENT.exec(line)?.[1]
      if (specifier === undefined || !ADAPTER_SPECIFIER.test(specifier)) continue
      violations.push({ file, specifier })
    }
  }
  cached = { violations, scanned: files.length }
  return cached
}

describe('package boundaries', () => {
  it('runs from the repository root', () => {
    // A wrong cwd would make the glob empty and the guard vacuously green.
    expect(existsSync(resolve(root, 'pnpm-workspace.yaml')), root).toBe(true)
  })

  it('lets no packages/** module import a platform adapter', () => {
    expect(scan().scanned).toBeGreaterThan(0)
    expect(scan().violations.map(violation => `${violation.file} imports ${violation.specifier}`)).toEqual([])
  }, 120_000)

  it('keeps the adapters mounted only in the IM bundle patch', () => {
    const patch = readFileSync(resolve(root, 'packages/experimental/im-bundle/cordis.patch.yml'), 'utf8')
    expect(ADAPTER_SPECIFIER.test(patch)).toBe(true)
  })
})
