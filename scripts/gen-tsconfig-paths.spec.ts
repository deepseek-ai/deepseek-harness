import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectPackageAliases,
  collectPackageNames,
  mappedSpecifiers,
  renderAliases,
  uncoveredPackages,
  writeRegion,
} from './gen-tsconfig-paths.ts'

const root = resolve(import.meta.dirname, '..')

describe('generated tsconfig package aliases', () => {
  it('maps each package to its own source directory', () => {
    const aliases = collectPackageAliases()
    expect(aliases.length).toBeGreaterThan(100)
    const session = aliases.find(alias => alias.specifier === '@deepseek-ai/dsh-session')
    expect(session).toEqual({
      specifier: '@deepseek-ai/dsh-session',
      source: './packages/core/session/src',
    })
    // Sorted, so a package added anywhere lands in a stable spot in the diff.
    expect([...aliases].sort((a, b) => a.specifier.localeCompare(b.specifier))).toEqual(aliases)
    // Only packages named after their directory: the rest carry hand-written
    // aliases, because the removed wildcards could never have resolved them.
    expect(aliases.some(alias => alias.specifier === '@deepseek-ai/dsh-typert-protocol')).toBe(false)
  })

  it('yields to a hand-written alias and closes without a trailing comma', () => {
    const aliases = [
      { specifier: '@deepseek-ai/dsh-a', source: './packages/g/a/src' },
      { specifier: '@deepseek-ai/dsh-b', source: './packages/g/b/src' },
      { specifier: '@deepseek-ai/dsh-c', source: './packages/g/c/src' },
    ]
    const body = renderAliases(aliases, new Set(['@deepseek-ai/dsh-a']))

    expect(body).toBe([
      '      "@deepseek-ai/dsh-b": ["./packages/g/b/src"]',
      '      "@deepseek-ai/dsh-c": ["./packages/g/c/src"]',
    ].join(',\n'))
    expect(body.endsWith(',')).toBe(false)
  })

  it('replaces only the marked region', () => {
    const text = [
      '{ "before": 1,',
      '      // BEGIN generated package aliases — pnpm run gen-tsconfig-paths',
      '      "stale": ["gone"]',
      '      // END generated package aliases',
      '  "after": 2 }',
    ].join('\n')

    const next = writeRegion(text, '      "fresh": ["kept"]')

    expect(next).toContain('{ "before": 1,')
    expect(next).toContain('  "after": 2 }')
    expect(next).toContain('"fresh": ["kept"]')
    expect(next).not.toContain('stale')
  })

  it('refuses a config without the region markers', () => {
    expect(() => writeRegion('{}', '')).toThrow('missing the generated-region markers')
  })

  it('names a package that no alias covers', () => {
    // Deleting the group wildcards removed the fallback that used to resolve a
    // package nobody had aliased. A package whose name does not match its
    // directory is skipped by the generator, so without this check it would
    // resolve through the workspace symlink to built lib/types instead.
    expect(uncoveredPackages(
      ['@deepseek-ai/dsh-a', '@deepseek-ai/dsh-b'],
      new Set(['@deepseek-ai/dsh-a']),
    )).toEqual(['@deepseek-ai/dsh-b'])

    expect(uncoveredPackages(['@deepseek-ai/dsh-a'], new Set(['@deepseek-ai/dsh-a']))).toEqual([])
  })

  it('covers every workspace package in the committed config', () => {
    const config = readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8')
    // Includes the packages the generator skips because their name does not
    // match their directory: those carry hand-written aliases.
    const names = collectPackageNames()
    expect(names).toContain('@deepseek-ai/dsh-typert-protocol')
    expect(uncoveredPackages(names, mappedSpecifiers(config))).toEqual([])
  })

  it('leaves no wildcard that probes every package group', () => {
    const config = readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8')
    // A wildcard lists one candidate per group, so resolving a package late in
    // the list costs a filesystem probe — and under tsx a decorated module
    // error — for every group before it.
    expect(config).not.toContain('"@deepseek-ai/dsh-*":')
  })
})
