import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectSessionFormatMigrations,
  readCurrentSessionFormatVersion,
  renderSessionFormatCatalog,
} from './gen-session-format-catalog.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(edges: Array<[number, number]>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-format-catalog-'))
  fixtureRoots.push(root)
  mkdirSync(join(root, 'packages/core/session/src'), { recursive: true })
  writeFileSync(join(root, 'packages/core/session/src/types.ts'), 'export const SESSION_FORMAT_VERSION = 2\n')
  const catalogDependencies: Record<string, string> = {}
  for (const [from, to] of edges) {
    const dir = join(root, `packages/session/session-format-v${from}-to-v${to}`)
    const name = `@deepseek-ai/dsh-session-format-v${from}-to-v${to}`
    mkdirSync(dir, { recursive: true })
    catalogDependencies[name] = 'workspace:^'
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      dsh: { sessionFormatMigration: {
        from, to, export: '.',
        migration: `sessionFormatV${from}ToV${to}`,
        sourceCodec: `releasedV${from}SessionFormatCodec`,
        targetCodec: `releasedV${to}SessionFormatCodec`,
        targetHeaderValidator: `assertReleasedV${to}Header`,
        targetRestorer: `restoreReleasedV${to}Artifact`,
      } },
      dependencies: from === 0
        ? { '@deepseek-ai/dsh-session-format': 'workspace:^' }
        : {
          '@deepseek-ai/dsh-session-format': 'workspace:^',
          [`@deepseek-ai/dsh-session-format-v${from - 1}-to-v${from}`]: 'workspace:^',
        },
    }))
  }
  const catalog = join(root, 'packages/session/session-format-catalog')
  mkdirSync(catalog, { recursive: true })
  writeFileSync(join(catalog, 'package.json'), JSON.stringify({
    dependencies: catalogDependencies,
    peerDependencies: { '@deepseek-ai/dsh-session': 'workspace:^' },
    devDependencies: { '@deepseek-ai/dsh-session': 'workspace:^' },
  }))
  return root
}

function edgeManifest(root: string, from: number, to: number): {
  path: string
  value: Record<string, unknown> & {
    dependencies: Record<string, string>
    dsh: { sessionFormatMigration: Record<string, unknown> }
  }
} {
  const path = join(root, `packages/session/session-format-v${from}-to-v${to}/package.json`)
  return {
    path,
    value: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & {
      dependencies: Record<string, string>
      dsh: { sessionFormatMigration: Record<string, unknown> }
    },
  }
}

describe('session format catalog generator', () => {
  it('normalizes Windows separators in discovered manifest paths before validation', async () => {
    const root = fixture([[0, 1], [1, 2]])
    vi.resetModules()
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        globSync: () => [
          'packages\\session\\session-format-v0-to-v1\\package.json',
          'packages\\session\\session-format-v1-to-v2\\package.json',
        ],
      }
    })

    try {
      const { collectSessionFormatMigrations: collect } = await import('./gen-session-format-catalog.ts')
      expect(collect(root, 2).map(item => [item.from, item.to])).toEqual([[0, 1], [1, 2]])
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('discovers one complete adjacent chain and renders direct imports', () => {
    const root = fixture([[0, 1], [1, 2]])
    const version = readCurrentSessionFormatVersion(root)
    const declarations = collectSessionFormatMigrations(root, version)
    const output = renderSessionFormatCatalog(declarations, version)

    expect(declarations.map(item => [item.from, item.to])).toEqual([[0, 1], [1, 2]])
    expect(output).toContain("from '@deepseek-ai/dsh-session-format-v0-to-v1'")
    expect(output).toContain('currentVersion: 2')
    expect(output).toContain('encodeCurrentArtifact: artifact => releasedV2SessionFormatCodec.encodeArtifact(artifact)')
    expect(output).toContain('restoreReleasedV2Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)')
    expect(output).toContain('assertReleasedV2Header(header)')
    expect(output).toContain('validateInstalledCurrentSessionHeader(header)')
    expect(output).toContain("from '@deepseek-ai/dsh-session'")
    expect(output).toContain("from './current.ts'")
    const imports = output.split('\n').filter(line => line.startsWith('import {'))
    expect(imports.filter(line => line.includes('releasedV1SessionFormatCodec'))).toHaveLength(1)
  })

  it('refuses a missing adjacent edge', () => {
    const root = fixture([[0, 1]])
    expect(() => collectSessionFormatMigrations(root, 2)).toThrow(/exactly one v1->v2/)
  })

  it('refuses a later edge whose declared source codec does not continue the prior target', () => {
    const root = fixture([[0, 1], [1, 2]])
    const manifest = edgeManifest(root, 1, 2)
    manifest.value.dsh.sessionFormatMigration['sourceCodec'] = 'UnrelatedV1Codec'
    writeFileSync(manifest.path, JSON.stringify(manifest.value))

    expect(() => collectSessionFormatMigrations(root, 2))
      .toThrow(/source codec UnrelatedV1Codec does not continue releasedV1SessionFormatCodec/)
  })

  it('requires every later edge to depend on the package that owns its source codec', () => {
    const root = fixture([[0, 1], [1, 2]])
    const manifest = edgeManifest(root, 1, 2)
    delete manifest.value.dependencies['@deepseek-ai/dsh-session-format-v0-to-v1']
    writeFileSync(manifest.path, JSON.stringify(manifest.value))

    expect(() => collectSessionFormatMigrations(root, 2))
      .toThrow(/must depend on @deepseek-ai\/dsh-session-format-v0-to-v1/)
  })

  it('requires the package name to identify its declared adjacent edge', () => {
    const root = fixture([[0, 1], [1, 2]])
    const manifest = edgeManifest(root, 1, 2)
    manifest.value['name'] = '@deepseek-ai/dsh-session-format-other'
    writeFileSync(manifest.path, JSON.stringify(manifest.value))

    expect(() => collectSessionFormatMigrations(root, 2))
      .toThrow(/name must be @deepseek-ai\/dsh-session-format-v1-to-v2/)
  })

  it('requires the catalog to share the installed Session package as a peer', () => {
    const root = fixture([[0, 1], [1, 2]])
    const path = join(root, 'packages/session/session-format-catalog/package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    manifest.dependencies['@deepseek-ai/dsh-session'] = 'workspace:^'
    delete manifest.peerDependencies['@deepseek-ai/dsh-session']
    writeFileSync(path, JSON.stringify(manifest))

    expect(() => collectSessionFormatMigrations(root, 2))
      .toThrow(/must share @deepseek-ai\/dsh-session through peer \+ dev dependencies/)
  })
})
