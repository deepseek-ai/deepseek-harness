import { describe, expect, it } from 'vitest'
import {
  applyFactsToRegistry,
  discoverBenchmarkCandidates,
  parseNextPackageBenchmarkOptions,
  type MutableRegistryManifest,
} from './benchmark-next-package-dependency.ts'
import type {
  PackageDependencyFacts,
  PackageDependencyManifest,
  WorkspacePackageManifest,
} from './verify-package-dependencies.ts'
import type { RegistryIndex } from './benchmark-npm-resolution.ts'

describe('next package benchmark options', () => {
  it('parses candidate and repetition controls', () => {
    expect(parseNextPackageBenchmarkOptions([
      '--',
      '--candidates=@f/a,@f/b',
      '--runs=2',
      '--finalist-runs=4',
      '--finalists=3',
      '--jobs=6',
      '--timeout-ms=9000',
    ])).toEqual({
      candidates: ['@f/a', '@f/b'],
      coarseRuns: 2,
      finalistRuns: 4,
      finalists: 3,
      jobs: 6,
      timeoutMs: 9000,
    })
  })

  it('rejects invalid positive integers', () => {
    expect(() => parseNextPackageBenchmarkOptions(['--jobs=0'])).toThrow('--jobs must be a positive integer')
  })
})

describe('next package benchmark graph', () => {
  it('applies a source-derived candidate without changing the filesystem', () => {
    const manifest: PackageDependencyManifest & { version: string } = {
      name: '@f/probe',
      version: '1.0.0',
      peerDependencies: {
        '@deepseek-ai/cordis': 'workspace:~',
        '@f/runtime': 'workspace:~',
        '@f/types': 'workspace:~',
      },
      devDependencies: {
        '@deepseek-ai/cordis': 'workspace:~',
        '@f/runtime': 'workspace:~',
        '@f/types': 'workspace:~',
      },
    }
    const facts: PackageDependencyFacts = {
      manifestPath: 'packages/g/probe/package.json',
      role: 'configured-host',
      manifest,
      workspaceNames: new Set(['@deepseek-ai/cordis', '@f/probe', '@f/runtime', '@f/types']),
      allSourceUses: new Map([
        ['@f/runtime', ['packages/g/probe/src/index.ts']],
        ['@f/types', ['packages/g/probe/src/types.ts']],
      ]),
      hostRuntimeSourceUses: new Map([['@f/runtime', ['packages/g/probe/src/index.ts']]]),
      hostRuntimeExportUses: [{
        packageName: '@f/runtime',
        specifier: '@f/runtime',
        exportName: 'runtimeValue',
        sourcePath: 'packages/g/probe/src/index.ts',
        line: 1,
        column: 10,
        sourceLine: "import { runtimeValue } from '@f/runtime'",
      }],
      peerRequiredHostDependencies: new Set(),
      configurationOnlyDevDependencies: new Set(),
      clientInject: new Set(),
    }
    const index = new Map<string, Map<string, MutableRegistryManifest>>([
      ['@f/probe', new Map([['1.0.0', structuredClone(manifest) as MutableRegistryManifest]])],
    ])
    applyFactsToRegistry(index, facts, new Map([
      ['@deepseek-ai/cordis', '4.0.1'],
      ['@f/probe', '1.0.0'],
      ['@f/runtime', '2.0.0'],
      ['@f/types', '3.0.0'],
    ]))

    expect(index.get('@f/probe')?.get('1.0.0')).toMatchObject({
      dependencies: { '@f/runtime': '~2.0.0' },
      peerDependencies: { '@deepseek-ai/cordis': '~4.0.1' },
    })
    expect(index.get('@f/probe')?.get('1.0.0')?.dependencies).not.toHaveProperty('@f/types')
  })

  it('finds reachable unconfigured packages with non-Cordis peers', () => {
    const index = new Map([
      ['@deepseek-ai/dsh', new Map([['1.0.0', {
        name: '@deepseek-ai/dsh', version: '1.0.0', dependencies: { '@f/a': '^1.0.0', '@f/b': '^1.0.0' },
      }]])],
      ['@f/a', new Map([['1.0.0', {
        name: '@f/a', version: '1.0.0', peerDependencies: { '@f/runtime': '^1.0.0' },
      }]])],
      ['@f/b', new Map([['1.0.0', {
        name: '@f/b', version: '1.0.0', peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
      }]])],
      ['@f/runtime', new Map([['1.0.0', { name: '@f/runtime', version: '1.0.0' }]])],
    ]) as RegistryIndex
    const release = new Map<string, WorkspacePackageManifest>([
      ['@f/a', {
        name: '@f/a', dir: 'packages/g/a', manifestPath: 'packages/g/a/package.json', manifest: { name: '@f/a' },
      }],
      ['@f/b', {
        name: '@f/b', dir: 'packages/g/b', manifestPath: 'packages/g/b/package.json', manifest: { name: '@f/b' },
      }],
    ])

    expect(discoverBenchmarkCandidates(
      index,
      new Map([['@deepseek-ai/dsh', '1.0.0'], ['@f/a', '1.0.0'], ['@f/b', '1.0.0']]),
      release,
      new Set(),
    )).toEqual(['@f/a'])
  })
})
