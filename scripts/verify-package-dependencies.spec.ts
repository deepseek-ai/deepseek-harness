import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PACKAGE_DEPENDENCY_POLICY,
  type PackageDependencyPolicy,
} from './package-dependency-policy.ts'
import {
  collectHostDependencyExportPolicyViolations,
  collectPackageDependencyViolations,
  collectRuntimeSourceExportUses,
  discoverPackageDependencyScope,
  expectedPackageDependencies,
  fixPackageDependencies,
  formatManagedRuntimeDependencies,
  formatPeerRequiredRuntimeDependencies,
  readPackageDependencyFacts,
  readPackageDependencyState,
  repairPackageDependencyManifest,
  type PackageDependencyFacts,
  type PackageDependencyManifest,
  type PackageDependencyRole,
  type WorkspacePackageManifest,
} from './verify-package-dependencies.ts'

const CORDIS = '@deepseek-ai/cordis'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function pkg(
  name: string,
  manifestPath: string,
  manifest: Partial<PackageDependencyManifest> = {},
): WorkspacePackageManifest {
  return {
    name,
    manifestPath,
    dir: dirname(manifestPath),
    manifest: { name, ...manifest },
  }
}

function policy(fields: Partial<PackageDependencyPolicy> = {}): PackageDependencyPolicy {
  return {
    clientFaceInclude: [],
    clientFaceExclude: [],
    hostPackages: [],
    configurationOnlyDevDependencies: {},
    safeHostDependencyExports: {},
    peerRequiredHostExports: {},
    ...fields,
  }
}

function facts(manifest: PackageDependencyManifest): PackageDependencyFacts {
  return {
    manifestPath: 'packages/core/probe/package.json',
    role: 'configured-host',
    manifest,
    workspaceNames: new Set([
      CORDIS,
      '@deepseek-ai/dsh-runtime',
      '@deepseek-ai/dsh-types',
      '@deepseek-ai/dsh-stale',
      '@deepseek-ai/schemastery',
    ]),
    allSourceUses: new Map([
      ['@deepseek-ai/dsh-runtime', ['packages/core/probe/src/index.ts']],
      ['@deepseek-ai/dsh-types', ['packages/core/probe/src/types.ts']],
    ]),
    hostRuntimeSourceUses: new Map([
      ['@deepseek-ai/dsh-runtime', ['packages/core/probe/src/index.ts']],
    ]),
    hostRuntimeExportUses: [{
      packageName: '@deepseek-ai/dsh-runtime',
      specifier: '@deepseek-ai/dsh-runtime',
      exportName: 'runtimeValue',
      sourcePath: 'packages/core/probe/src/index.ts',
      line: 1,
      column: 10,
      sourceLine: "import { runtimeValue } from '@deepseek-ai/dsh-runtime'",
    }],
    peerRequiredHostDependencies: new Set(),
    configurationOnlyDevDependencies: new Set(),
    clientInject: new Set(),
  }
}

function sourceFacts(
  files: Readonly<Record<string, string>>,
  manifest: Partial<PackageDependencyManifest> = {},
  role: PackageDependencyRole = 'client-host',
): PackageDependencyFacts {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dependency-source-'))
  roots.push(root)
  const subject = pkg('@f/probe', 'packages/g/probe/package.json', manifest)
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, subject.dir, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source)
  }
  return readPackageDependencyFacts(root, subject, role, new Set([CORDIS, subject.name]), policy())
}

function generatedHostFixture(mode: 'schema' | 'object'): { root: string; manifestPath: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-generated-host-dependencies-'))
  roots.push(root)
  const manifestPath = 'packages/client/probe/package.json'
  const source = `/** @typert ${mode} */\nexport interface Payload { value: string }\n`
  const manifest = {
    name: '@fixture/generated',
    type: 'module',
    dsh: { client: {} },
    exports: {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    },
    files: ['lib/typert.host.js', 'lib/typert.host.d.ts'],
    dependencies: { zod: '^4.0.0' },
    devDependencies: { [CORDIS]: 'workspace:^' },
    peerDependencies: { [CORDIS]: 'workspace:^' },
  }
  const files = {
    'tsconfig.base.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
        composite: true, noEmit: true, types: [], skipLibCheck: true,
      },
    }),
    'tsconfig.host.json': JSON.stringify({
      extends: './tsconfig.base.json', files: [], references: [{ path: './packages/client/probe' }],
    }),
    'packages/client/probe/tsconfig.json': JSON.stringify({
      extends: '../../../tsconfig.base.json', compilerOptions: { rootDir: 'src' }, include: ['src'],
    }),
    [manifestPath]: JSON.stringify(manifest),
    'packages/client/probe/src/index.ts': source,
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return { root, manifestPath, source }
}

function hostRuntimeFixture(): {
  provider: WorkspacePackageManifest
  workspaceNames: Set<string>
  consumerFacts: PackageDependencyFacts
} {
  const consumer = pkg('@f/consumer', 'packages/core/consumer/package.json')
  const provider = pkg('@f/provider', 'packages/core/provider/package.json')
  const sourcePath = 'packages/core/consumer/src/index.ts'
  const specifier = `${provider.name}/api`
  const workspaceNames = new Set([CORDIS, consumer.name, provider.name])
  const consumerFacts: PackageDependencyFacts = {
    manifestPath: consumer.manifestPath,
    role: 'configured-host',
    manifest: consumer.manifest,
    workspaceNames,
    allSourceUses: new Map(),
    hostRuntimeSourceUses: new Map([[provider.name, [sourcePath]]]),
    hostRuntimeExportUses: [{
      packageName: provider.name,
      specifier,
      exportName: 'safeValue',
      sourcePath,
      line: 1,
      column: 10,
      sourceLine: `import { safeValue } from '${specifier}'`,
    }],
    peerRequiredHostDependencies: new Set(),
    configurationOnlyDevDependencies: new Set(),
    clientInject: new Set(),
  }
  return { provider, workspaceNames, consumerFacts }
}

describe('package dependency scope', () => {
  it('keeps the measured Host relay roster explicit', () => {
    expect(PACKAGE_DEPENDENCY_POLICY.clientFaceExclude).toEqual([
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-api-workspace-controller',
    ])
    expect(PACKAGE_DEPENDENCY_POLICY.hostPackages).toEqual([
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
    ])
    expect(PACKAGE_DEPENDENCY_POLICY.configurationOnlyDevDependencies).toEqual({
      '@deepseek-ai/dsh-client-locale': ['@deepseek-ai/dsh-api-remotes'],
      '@deepseek-ai/dsh-client-ui-conversation': [
        '@deepseek-ai/dsh-api-remotes',
        '@deepseek-ai/dsh-client-ui-workspace',
      ],
      '@deepseek-ai/dsh-client-ui-model-selection': ['@deepseek-ai/dsh-client-ui-input-trigger'],
      '@deepseek-ai/dsh-client-ui-sidebar': ['@deepseek-ai/dsh-client-ui-workspace'],
      '@deepseek-ai/dsh-client-ui-subagent': ['@deepseek-ai/dsh-client-ui-input-trigger'],
      '@deepseek-ai/dsh-client-ui-theme': ['@deepseek-ai/dsh-api-remotes'],
      '@deepseek-ai/dsh-client-ui-tool': ['@deepseek-ai/dsh-api-remotes'],
    })
    expect(PACKAGE_DEPENDENCY_POLICY.duplicateSafePackages).toEqual([
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-util-crypto',
      '@deepseek-ai/dsh-util-values',
    ])
    expect(PACKAGE_DEPENDENCY_POLICY.safeHostDependencyExports['@deepseek-ai/dsh-deque']).toEqual(['Deque'])
    expect(PACKAGE_DEPENDENCY_POLICY.safeHostDependencyExports['@deepseek-ai/schemastery']).toEqual(['default'])
    expect(PACKAGE_DEPENDENCY_POLICY.safeHostDependencyExports['@deepseek-ai/dsh-session/types']).toBeUndefined()
    expect(PACKAGE_DEPENDENCY_POLICY.safeHostDependencyExports['@deepseek-ai/dsh-typert-protocol']).toBeUndefined()
    expect(PACKAGE_DEPENDENCY_POLICY.peerRequiredHostExports['@deepseek-ai/dsh-scope']).toEqual([
      'carrierKeyOf', 'scopeOf', 'scopeTarget',
    ])
    expect(PACKAGE_DEPENDENCY_POLICY.peerRequiredHostExports['@deepseek-ai/dsh-typert-protocol']).toBeUndefined()
  })

  it('discovers the Client directory, dsh.client declarations, and configured Host packages', () => {
    const packages = [
      pkg('@f/static', 'packages/client/static/package.json'),
      pkg('@f/dynamic-client', 'packages/client/dynamic/package.json', { dsh: { client: {} } }),
      pkg('@f/dual', 'packages/api/dual/package.json', { dsh: { client: {} } }),
      pkg('@f/export-only', 'packages/api/export-only/package.json', { exports: { './client': './lib/client.js' } }),
      pkg('@f/forced-client', 'packages/api/forced/package.json'),
      pkg('@f/excluded', 'packages/api/excluded/package.json', { dsh: { client: {} } }),
      pkg('@f/host', 'packages/core/host/package.json'),
    ]

    const found = discoverPackageDependencyScope(packages, policy({
      clientFaceInclude: ['@f/forced-client'],
      clientFaceExclude: ['@f/excluded'],
      hostPackages: ['@f/host'],
    }))

    expect(found.violations).toEqual([])
    expect(found.selected.map(item => [item.name, item.role])).toEqual([
      ['@f/dual', 'client-host'],
      ['@f/forced-client', 'client-host'],
      ['@f/dynamic-client', 'client-host'],
      ['@f/static', 'client-only'],
      ['@f/host', 'configured-host'],
    ])
  })

  it('rejects stale, redundant, overlapping, and unknown configuration', () => {
    const packages = [
      pkg('@f/client', 'packages/client/client/package.json'),
      pkg('@f/dual', 'packages/api/dual/package.json', { dsh: { client: {} } }),
      pkg('@f/host', 'packages/core/host/package.json'),
    ]
    const found = discoverPackageDependencyScope(packages, policy({
      clientFaceInclude: ['@f/dual', '@f/missing', '@f/host'],
      clientFaceExclude: ['@f/client', '@f/host', '@f/missing'],
      hostPackages: ['@f/dual'],
    }))

    expect(found.violations).toEqual(expect.arrayContaining([
      expect.stringContaining('clientFaceInclude redundantly names automatically discovered package @f/dual'),
      expect.stringContaining('@f/host appears in both clientFaceInclude and clientFaceExclude'),
      expect.stringContaining('clientFaceExclude cannot exempt packages/client package @f/client'),
      expect.stringContaining('clientFaceExclude names @f/host, which declares no dsh.client entry'),
      expect.stringContaining('hostPackages redundantly names Client-faced package @f/dual'),
      expect.stringContaining('unknown release package @f/missing'),
    ]))
  })

  it('rejects stale, duplicate, and unbounded safe Host export entries', () => {
    const { provider, workspaceNames, consumerFacts } = hostRuntimeFixture()

    expect(collectHostDependencyExportPolicyViolations(
      [consumerFacts],
      workspaceNames,
      {
        safeHostDependencyExports: {
          [`${provider.name}/api`]: ['safeValue', 'safeValue', '*', 'staleValue'],
        },
        peerRequiredHostExports: {
          [`${provider.name}/api`]: ['safeValue'],
        },
      },
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('export safeValue more than once'),
      expect.stringContaining('cannot classify unbounded'),
      expect.stringContaining('unused @f/provider/api export staleValue'),
      expect.stringContaining('appears in both Host export classifications'),
    ]))
  })

  it('applies a duplicate-safe package classification to its subpaths', () => {
    const { provider, workspaceNames, consumerFacts } = hostRuntimeFixture()

    expect(collectHostDependencyExportPolicyViolations(
      [consumerFacts],
      workspaceNames,
      {
        duplicateSafePackages: [provider.name],
        safeHostDependencyExports: {},
        peerRequiredHostExports: {},
      },
    )).toEqual([])
    expect(collectHostDependencyExportPolicyViolations(
      [consumerFacts],
      workspaceNames,
      {
        duplicateSafePackages: [provider.name],
        safeHostDependencyExports: { [`${provider.name}/api`]: ['safeValue'] },
        peerRequiredHostExports: {},
      },
    )).toContain(`safeHostDependencyExports redundantly classifies duplicate-install-safe package ${provider.name}/api`)
  })
})

describe('face-aware source classification', () => {
  it('keeps generated Host schema imports in dependencies without reading or writing lib', () => {
    const { root, manifestPath, source } = generatedHostFixture('schema')
    const before = readFileSync(join(root, manifestPath), 'utf8')
    const state = readPackageDependencyState(root, policy())
    const subject = state.facts[0]
    if (subject === undefined) throw new Error('generated Host fixture was not classified')

    expect(subject.allSourceUses.has('zod')).toBe(false)
    expect(subject.hostRuntimeExportUses).toContainEqual(expect.objectContaining({
      packageName: 'zod', specifier: 'zod', exportName: 'z',
      sourcePath: 'packages/client/probe/lib/typert.host.js',
    }))
    const standalone = readPackageDependencyFacts(root, pkg('@fixture/generated', manifestPath, subject.manifest),
      subject.role, state.workspaceNames, policy())
    expect(standalone.hostRuntimeExportUses).toEqual(subject.hostRuntimeExportUses)
    expect(collectPackageDependencyViolations(state)).toEqual([])
    repairPackageDependencyManifest(subject)
    expect(subject.manifest.dependencies?.zod).toBe('^4.0.0')
    expect(subject.manifest.devDependencies?.zod).toBeUndefined()

    delete subject.manifest.dependencies?.zod
    subject.manifest.devDependencies = { ...subject.manifest.devDependencies, zod: '^4.0.0' }
    expect(collectPackageDependencyViolations(state)).toContainEqual(
      expect.stringContaining('must be dependencies-only; found devDependencies'),
    )
    repairPackageDependencyManifest(subject)
    expect(subject.manifest.dependencies?.zod).toBe('^4.0.0')
    expect(subject.manifest.devDependencies?.zod).toBeUndefined()

    delete subject.manifest.dependencies?.zod
    expect(() => { repairPackageDependencyManifest(subject) }).toThrow('undeclared third-party dependency zod')
    expect(existsSync(join(root, 'packages/client/probe/lib'))).toBe(false)
    expect(readFileSync(join(root, manifestPath), 'utf8')).toBe(before)
    expect(readFileSync(join(root, 'packages/client/probe/src/index.ts'), 'utf8')).toBe(source)
  })

  it('does not infer a zod runtime dependency from a metadata-only Typert export', () => {
    const { root } = generatedHostFixture('object')
    const state = readPackageDependencyState(root, policy())
    const subject = state.facts[0]
    if (subject === undefined) throw new Error('generated Host fixture was not classified')

    expect(subject.hostRuntimeSourceUses.has('zod')).toBe(false)
    expect(expectedPackageDependencies(subject).get('zod')?.section).toBe('devDependencies')
    repairPackageDependencyManifest(subject)
    expect(subject.manifest.dependencies?.zod).toBeUndefined()
    expect(subject.manifest.devDependencies?.zod).toBe('^4.0.0')
    expect(existsSync(join(root, 'packages/client/probe/lib'))).toBe(false)
  })

  it('rejects a declared Host Typert module absent from the Host program', () => {
    const { root } = generatedHostFixture('schema')
    rmSync(join(root, 'tsconfig.host.json'))

    expect(() => readPackageDependencyState(root, policy())).toThrow(
      'packages/client/probe/package.json: declared Host Typert export has no generated module',
    )
    expect(existsSync(join(root, 'packages/client/probe/lib'))).toBe(false)
  })

  it('propagates generator publication errors without writing or repairing manifests', () => {
    const { root, manifestPath } = generatedHostFixture('schema')
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as { files: string[] }
    manifest.files = []
    const before = JSON.stringify(manifest)
    writeFileSync(join(root, manifestPath), before)

    expect(() => readPackageDependencyState(root, policy())).toThrow(
      'package files must include lib/typert.host.js',
    )
    expect(readFileSync(join(root, manifestPath), 'utf8')).toBe(before)
    expect(existsSync(join(root, 'packages/client/probe/lib'))).toBe(false)
  })

  it('counts browser imports, JSX, type-only references, and augmentations as development inputs', () => {
    const subject = sourceFacts({
      'src/index.ts': [
        "import { readFile } from 'node:fs'",
        "import { join } from 'path'",
        "import type { HostType } from 'host-types'",
        "import { type MixedType } from 'mixed-types'",
        "import type { Hidden } from './type-helper.ts'",
      ].join('\n'),
      'src/type-helper.ts': "import { hidden } from 'hidden-value'; export type Hidden = typeof hidden",
      'src/client/index.tsx': [
        "import { browser } from '@browser/kit/subpath'",
        "import 'react-dom/client'",
        "import '#local'",
        "import 'https://example.test/browser.js'",
        'export const view = <div />',
      ].join('\n'),
      'src/client/augmentation.d.ts': [
        "declare module 'augmented' { interface Extra {} }",
        "declare module '*.css' {}",
        "declare module '*.module.css' {}",
      ].join('\n'),
    })

    expect([...subject.hostRuntimeSourceUses]).toEqual([])
    expect([...expectedPackageDependencies(subject)].map(([name, rule]) => [name, rule.section]).sort()).toEqual([
      ['@browser/kit', 'devDependencies'],
      [CORDIS, 'peer-dev'],
      ['augmented', 'devDependencies'],
      ['hidden-value', 'devDependencies'],
      ['host-types', 'devDependencies'],
      ['mixed-types', 'devDependencies'],
      ['react', 'devDependencies'],
      ['react-dom', 'devDependencies'],
    ])
  })

  it.each(['client-host', 'configured-host'] as const)('retains Host and shared third-party values in dependencies for %s', (role) => {
    const subject = sourceFacts({
      'src/index.ts': "import 'host-only'; export { shared } from './nested.ts'",
      'src/nested.ts': "export { shared } from 'shared-runtime'",
      'src/client/index.ts': "import 'browser-only'; import 'shared-runtime'",
    }, {}, role)

    const expected = expectedPackageDependencies(subject)
    expect(expected.get('browser-only')?.section).toBe('devDependencies')
    expect(expected.get('host-only')?.section).toBe('dependencies')
    expect(expected.get('shared-runtime')?.section).toBe('dependencies')
  })

  it('uses declared DefinitelyTyped providers only for erased source references', () => {
    const subject = sourceFacts({
      'src/index.ts': "import type { ReactNode } from 'react'",
      'src/client/index.ts': "import type { Root } from 'mdast'; import type { Kind } from '@scope/types'",
    }, {
      dependencies: { '@types/mdast': '^4.0.0' },
      devDependencies: { '@types/react': '^18.0.0', '@types/scope__types': '^1.0.0' },
    })

    expect([...subject.allSourceUses.keys()].sort()).toEqual(['@types/mdast', '@types/react', '@types/scope__types'])
    expect([...subject.hostRuntimeSourceUses]).toEqual([])
    repairPackageDependencyManifest(subject)
    expect(subject.manifest.devDependencies?.['@types/mdast']).toBe('^4.0.0')
    expect(subject.manifest.dependencies?.['@types/mdast']).toBeUndefined()
    expect(subject.manifest.devDependencies?.mdast).toBeUndefined()
  })

  it.each(["import 'runtime-library'", 'export const view = <div />'])('does not let type providers satisfy runtime imports or JSX: %s', (source) => {
    const name = source.includes('<div') ? 'react' : 'runtime-library'
    const subject = sourceFacts({
      'src/index.ts': 'export function apply() {}',
      'src/client/index.tsx': source,
    }, { devDependencies: { [`@types/${name}`]: '^1.0.0' } })

    expect(subject.allSourceUses.has(name)).toBe(true)
    expect(() => { repairPackageDependencyManifest(subject) }).toThrow(`undeclared third-party dependency ${name}`)
  })

  it('does not treat static browser library entries as Host modules', () => {
    const subject = sourceFacts({
      'src/index.tsx': "import 'static-input'; export const view = <div />",
      'src/invariant.ts': "import 'browser-companion'",
    }, {
      exports: {
        '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
        './invariant': { types: './lib/types/invariant.d.ts', default: './lib/invariant.js' },
      },
    }, 'client-only')

    expect([...subject.hostRuntimeSourceUses]).toEqual([])
    for (const name of ['static-input', 'react', 'browser-companion']) {
      expect(expectedPackageDependencies(subject).get(name)?.section).toBe('devDependencies')
    }
  })

  it('scans published Node companions, conditional entries, and emitted-tree subpaths from source', () => {
    const subject = sourceFacts({
      'src/index.ts': 'export function apply() {}',
      'src/invariant.ts': "import 'invariant-runtime'; import type { Kind } from 'invariant-types'",
      'src/node/helper.ts': "export { helper } from 'node-helper'",
      'src/node.mts': "import 'node-import'",
      'src/node.cts': "require('node-require')",
      'src/emitted.tsx': 'export const view = <div />',
      'src/worker/one.ts': "import 'worker-one'",
      'src/worker/two.ts': "import('worker-two')",
      'src/client/index.ts': "import 'browser-only'",
      'src/types-only.ts': "import 'type-export-only'",
    }, {
      exports: {
        '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
        './invariant': { types: './lib/types/invariant.d.ts', default: './lib/invariant.js' },
        './renamed': { types: './lib/types/node/helper.d.ts', default: './lib/node-bundle.js' },
        './conditional': { browser: './lib/browser.js', node: { import: './lib/node.mjs', require: './lib/node.cjs' } },
        './emitted': { types: './lib/types/emitted.d.ts', default: './lib/types/emitted.js' },
        './worker/*': './lib/worker/*.js',
        './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' },
        './client/extra': './lib/missing-browser.js',
        './types-only': { types: './lib/types/types-only.d.ts' },
        './src/*': './src/*',
        './package.json': './package.json',
        './disabled': null,
      },
    })

    expect([...subject.hostRuntimeSourceUses.keys()].sort()).toEqual([
      'invariant-runtime', 'node-helper', 'node-import', 'node-require', 'react', 'worker-one', 'worker-two',
    ])
    const expected = expectedPackageDependencies(subject)
    for (const name of subject.hostRuntimeSourceUses.keys()) expect(expected.get(name)?.section).toBe('dependencies')
    for (const name of ['browser-only', 'invariant-types', 'type-export-only']) {
      expect(expected.get(name)?.section).toBe('devDependencies')
    }
  })

  it.each([
    './lib/missing.js',
    { types: './lib/types/missing.d.ts', default: './lib/renamed.js' },
    ['./lib/missing.cjs'],
    './lib/missing/*.js',
  ])('rejects a published Node entry with no matching source: %j', (target) => {
    expect(() => sourceFacts({ 'src/index.ts': 'export function apply() {}' }, {
      exports: { './node': target },
    })).toThrow('Host export ./node has no source entry')
  })

  it('rejects a Node export outside the source mapping', () => {
    expect(() => sourceFacts({ 'src/index.ts': 'export function apply() {}' }, {
      exports: { './node': './other/node.js' },
    })).toThrow('Host export ./node cannot map ./other/node.js to a source entry')
  })

  it('fails when a managed Host package has no Host entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-missing-host-'))
    roots.push(root)
    const subject = pkg('@f/host', 'packages/g/host/package.json')

    expect(() => readPackageDependencyFacts(root, subject, 'configured-host', new Set([subject.name])))
      .toThrow('packages/g/host/package.json: Host runtime entry packages/g/host/src/index.ts does not exist')
  })

  it('counts Host values as dependencies and Client values as development inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-faces-'))
    roots.push(root)
    const subject = pkg('@f/dual', 'packages/g/dual/package.json', {
      dsh: { client: { inject: ['@f/injected'] } },
    })
    const files = {
      'packages/g/dual/src/index.ts': [
        "import { value } from '@f/runtime'",
        "import type { Shared } from '@f/types'",
        "import type { Hidden } from './types.ts'",
        "export { nested } from './nested.ts'",
      ].join('\n'),
      'packages/g/dual/src/nested.ts': "export { nested } from '@f/nested'",
      'packages/g/dual/src/types.ts': "import { hidden } from '@f/hidden'; export type Hidden = typeof hidden",
      'packages/g/dual/src/client/index.ts': "import { browser } from '@f/browser'",
    }
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), source)
    }
    const found = readPackageDependencyFacts(root, subject, 'client-host', new Set([
      CORDIS, '@f/runtime', '@f/types', '@f/nested', '@f/hidden', '@f/browser', '@f/injected',
    ]), policy({
      configurationOnlyDevDependencies: { '@f/dual': ['@f/injected'] },
    }))

    expect([...found.hostRuntimeSourceUses.keys()].sort()).toEqual(['@f/nested', '@f/runtime'])
    expect([...found.configurationOnlyDevDependencies]).toEqual(['@f/injected'])
    expect(found.hostRuntimeExportUses).toEqual([
      {
        packageName: '@f/nested',
        specifier: '@f/nested',
        exportName: 'nested',
        sourcePath: 'packages/g/dual/src/nested.ts',
        line: 1,
        column: 10,
        sourceLine: "export { nested } from '@f/nested'",
      },
      {
        packageName: '@f/runtime',
        specifier: '@f/runtime',
        exportName: 'value',
        sourcePath: 'packages/g/dual/src/index.ts',
        line: 1,
        column: 10,
        sourceLine: "import { value } from '@f/runtime'",
      },
    ])
    expect([...found.allSourceUses.keys()].sort()).toEqual([
      '@f/browser', '@f/hidden', '@f/nested', '@f/runtime', '@f/types',
    ])
  })

  it('identifies exact runtime exports without treating type imports as values', () => {
    const source = [
      "import defaultValue, { value as local, type Kind } from '@f/root'",
      "import * as namespace from '@f/namespace'",
      "import '@f/effect'",
      "import type { TypeOnly } from '@f/types'",
      "export { source as renamed, type SourceType } from '@f/reexport'",
      "export * from '@f/star'",
      "void import('@f/dynamic')",
      "void require('@f/required')",
      'void defaultValue; void local; void namespace',
    ].join('\n')
    const uses = collectRuntimeSourceExportUses('probe.ts', source)
    expect(uses.map(({ specifier, exportName }) => ({ specifier, exportName }))).toEqual([
      { specifier: '@f/dynamic', exportName: '*' },
      { specifier: '@f/effect', exportName: '(side effect)' },
      { specifier: '@f/namespace', exportName: '*' },
      { specifier: '@f/reexport', exportName: 'source' },
      { specifier: '@f/required', exportName: '*' },
      { specifier: '@f/root', exportName: 'default' },
      { specifier: '@f/root', exportName: 'value' },
      { specifier: '@f/star', exportName: '*' },
    ])
    expect(uses.find(use => use.specifier === '@f/root' && use.exportName === 'value')).toMatchObject({
      line: 1,
      column: 24,
      sourceLine: "import defaultValue, { value as local, type Kind } from '@f/root'",
    })
  })
})

describe('dependency sections', () => {
  it.each(['client-only', 'client-host'] as const)('moves unused third-party and CSS inputs to development dependencies for %s', (role) => {
    const subject = sourceFacts({
      'src/index.ts': "import 'host-runtime'",
    }, {
      dependencies: { 'unused-browser-dep': '^1.2.3', '@fontsource/test-font': '~2.0.0', 'host-runtime': '^3.0.0' },
      optionalDependencies: { 'unused-optional': '^4.0.0' },
    }, role)

    repairPackageDependencyManifest(subject)
    expect(subject.manifest.devDependencies).toMatchObject({
      'unused-browser-dep': '^1.2.3',
      '@fontsource/test-font': '~2.0.0',
      'unused-optional': '^4.0.0',
    })
    expect(subject.manifest.dependencies).toEqual(role === 'client-host' ? { 'host-runtime': '^3.0.0' } : undefined)
    expect(subject.manifest.optionalDependencies).toBeUndefined()
    const repaired = structuredClone(subject.manifest)
    repairPackageDependencyManifest(subject)
    expect(subject.manifest).toEqual(repaired)
  })

  it('preserves unreferenced third-party declarations in configured Host packages', () => {
    const subject = sourceFacts({ 'src/index.ts': 'export function apply() {}' }, {
      dependencies: { 'unused-host-dep': '^1.0.0' },
      optionalDependencies: { 'unused-host-optional': '^2.0.0' },
    }, 'configured-host')

    repairPackageDependencyManifest(subject)
    expect(subject.manifest.dependencies).toEqual({ 'unused-host-dep': '^1.0.0' })
    expect(subject.manifest.optionalDependencies).toEqual({ 'unused-host-optional': '^2.0.0' })
  })

  it.each(['peerDependencies', 'optionalDependencies'] as const)('rejects browser-only imports declared in %s', (section) => {
    const subject = sourceFacts({
      'src/index.ts': 'export function apply() {}',
      'src/client/index.ts': "import 'external'",
    }, {
      devDependencies: { [CORDIS]: 'workspace:^' },
      peerDependencies: { [CORDIS]: 'workspace:^' },
      [section]: { [CORDIS]: 'workspace:^', external: '~1.2.3' },
      peerDependenciesMeta: { external: { optional: true } },
    })
    if (section === 'optionalDependencies') delete subject.manifest.optionalDependencies?.[CORDIS]
    const state = { facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames }

    expect(collectPackageDependencyViolations(state)).toContainEqual(
      expect.stringContaining(`must be devDependencies-only; found ${section}`),
    )
    repairPackageDependencyManifest(subject)
    expect(subject.manifest.devDependencies?.external).toBe('~1.2.3')
    expect(subject.manifest[section]?.external).toBeUndefined()
    expect(subject.manifest.peerDependenciesMeta).toBeUndefined()
    expect(collectPackageDependencyViolations(state)).toEqual([])
  })

  it('rejects a missing third-party declaration and leaves the in-memory manifest unchanged', () => {
    const subject = sourceFacts({
      'src/index.ts': 'export function apply() {}',
      'src/client/index.ts': "import 'undeclared'",
    })
    const before = structuredClone(subject.manifest)
    const state = { facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames }

    expect(collectPackageDependencyViolations(state)).toContain(
      'packages/g/probe/package.json: undeclared (packages/g/probe/src/client/index.ts) '
      + 'must be devDependencies-only; found no dependency section',
    )
    expect(() => { repairPackageDependencyManifest(subject) }).toThrow(
      'packages/g/probe/package.json: cannot repair undeclared third-party dependency undeclared; declare its version range first',
    )
    expect(subject.manifest).toEqual(before)
  })

  it('validates every third-party range before writing any manifest in a repair batch', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dependency-batch-'))
    roots.push(root)
    const valid = { ...facts({ name: '@deepseek-ai/dsh-first' }), manifestPath: 'first.json' }
    const base = facts({ name: '@deepseek-ai/dsh-second' })
    const invalid: PackageDependencyFacts = {
      ...base,
      manifestPath: 'second.json',
      allSourceUses: new Map([...base.allSourceUses, ['undeclared', ['src/client/index.ts']]]),
    }
    const subjects = [valid, invalid]
    const originals = subjects.map(subject => ({ subject, content: `${JSON.stringify(subject.manifest)}\n` }))
    for (const { subject, content } of originals) writeFileSync(join(root, subject.manifestPath), content)
    const state = { facts: subjects, packages: [], policyViolations: [], workspaceNames: valid.workspaceNames }

    expect(fixPackageDependencies(root, { ...state, policyViolations: ['unclassified Host export'] })).toEqual([])
    expect(() => fixPackageDependencies(root, state)).toThrow(
      'second.json: cannot repair undeclared third-party dependency undeclared; declare its version range first',
    )
    for (const { subject, content } of originals) {
      expect(readFileSync(join(root, subject.manifestPath), 'utf8')).toBe(content)
      expect(`${JSON.stringify(subject.manifest)}\n`).toBe(content)
    }
  })

  it('moves browser-only third-party imports to development dependencies without changing their ranges', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: { '@deepseek-ai/dsh-runtime': 'workspace:^', external: '^1.2.3' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-types': 'workspace:^' },
      peerDependencies: { [CORDIS]: 'workspace:^' },
    }
    const base = facts(manifest)
    const subject: PackageDependencyFacts = {
      ...base,
      allSourceUses: new Map([...base.allSourceUses, ['external', ['packages/core/probe/src/client/index.ts']]]),
    }
    const state = { facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames }

    expect(collectPackageDependencyViolations(state)).toEqual([
      'packages/core/probe/package.json: external (packages/core/probe/src/client/index.ts) '
      + 'must be devDependencies-only; found dependencies',
    ])
    repairPackageDependencyManifest(subject)
    expect(manifest.dependencies?.external).toBeUndefined()
    expect(manifest.devDependencies?.external).toBe('^1.2.3')
    expect(collectPackageDependencyViolations(state)).toEqual([])
    const repaired = structuredClone(manifest)
    repairPackageDependencyManifest(subject)
    expect(manifest).toEqual(repaired)
  })

  it('does not leak repository configuration into captured dependency facts', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-client-locale',
      dependencies: { '@deepseek-ai/dsh-runtime': 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-types': 'workspace:^' },
      peerDependencies: { [CORDIS]: 'workspace:^' },
    }
    const base = facts(manifest)
    const subject: PackageDependencyFacts = {
      ...base,
      workspaceNames: new Set([...base.workspaceNames, '@deepseek-ai/dsh-api-remotes']),
    }

    expect(collectPackageDependencyViolations({
      facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames,
    })).toEqual([])
  })

  it('requires non-workspace Host runtime imports in dependencies', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: { '@deepseek-ai/dsh-runtime': 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-types': 'workspace:^', external: '^1.0.0' },
      peerDependencies: { [CORDIS]: 'workspace:^' },
    }
    const subject: PackageDependencyFacts = {
      ...facts(manifest),
      hostRuntimeSourceUses: new Map([
        ['@deepseek-ai/dsh-runtime', ['packages/core/probe/src/index.ts']],
        ['external', ['packages/core/probe/src/index.ts']],
      ]),
      allSourceUses: new Map([
        ...facts(manifest).allSourceUses,
        ['external', ['packages/core/probe/src/client/index.ts']],
      ]),
    }
    const state = {
      facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames,
    }

    expect(collectPackageDependencyViolations(state)).toContain(
      'packages/core/probe/package.json: external (packages/core/probe/src/client/index.ts, packages/core/probe/src/index.ts) '
      + 'must be dependencies-only; found devDependencies',
    )
    repairPackageDependencyManifest(subject)
    expect(manifest.dependencies?.external).toBe('^1.0.0')
    expect(manifest.devDependencies?.external).toBeUndefined()
    const repaired = structuredClone(manifest)
    repairPackageDependencyManifest(subject)
    expect(manifest).toEqual(repaired)

    delete manifest.dependencies?.external
    expect(collectPackageDependencyViolations(state)).toContain(
      'packages/core/probe/package.json: external (packages/core/probe/src/client/index.ts, packages/core/probe/src/index.ts) '
      + 'must be dependencies-only; found no dependency section',
    )
  })

  it('accepts Host dependencies, development-only inputs, and shared Cordis', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: {
        '@deepseek-ai/dsh-runtime': 'workspace:^',
        '@deepseek-ai/schemastery': 'workspace:^',
        external: '^1.0.0',
      },
      devDependencies: {
        '@deepseek-ai/dsh-types': 'workspace:^',
        [CORDIS]: 'workspace:^',
      },
      peerDependencies: { [CORDIS]: 'workspace:^' },
    }
    expect(collectPackageDependencyViolations({
      facts: [facts(manifest)], packages: [], policyViolations: [], workspaceNames: facts(manifest).workspaceNames,
    })).toEqual([])
  })

  it('lists managed Host runtime dependencies for fix review', () => {
    const subject = facts({ name: '@deepseek-ai/dsh-probe' })
    expect(formatManagedRuntimeDependencies({
      facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames,
    })).toEqual([
      'verify-package-dependencies: 1 managed Host runtime edge(s) remain in dependencies across 1 package(s):',
      '  @deepseek-ai/dsh-probe -> @deepseek-ai/dsh-runtime: @deepseek-ai/dsh-runtime#runtimeValue',
    ])
  })

  it('reports an unapproved Host runtime export without rewriting its dependency section', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: { '@deepseek-ai/dsh-runtime': 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-types': 'workspace:^' },
      peerDependencies: { [CORDIS]: 'workspace:^' },
    }
    const subject = facts(manifest)
    const safetyViolations = collectHostDependencyExportPolicyViolations(
      [subject],
      subject.workspaceNames,
      { safeHostDependencyExports: {}, peerRequiredHostExports: {} },
    )
    const state = {
      facts: [subject], packages: [], policyViolations: safetyViolations, workspaceNames: subject.workspaceNames,
    }

    expect(safetyViolations).toEqual([
      'packages/core/probe/src/index.ts:1:10: @deepseek-ai/dsh-runtime#runtimeValue is not classified as '
      + 'safe or peer-required — import { runtimeValue } from \'@deepseek-ai/dsh-runtime\'',
    ])
    expect(fixPackageDependencies('/unused', state)).toEqual([])
    expect(manifest.dependencies).toEqual({ '@deepseek-ai/dsh-runtime': 'workspace:^' })
  })

  it('keeps an edge as a peer when one imported export requires shared identity', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: { '@deepseek-ai/dsh-runtime': 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-types': 'workspace:^' },
      peerDependencies: { [CORDIS]: 'workspace:^' },
    }
    const subject: PackageDependencyFacts = {
      ...facts(manifest),
      peerRequiredHostDependencies: new Set(['@deepseek-ai/dsh-runtime']),
    }
    expect(collectHostDependencyExportPolicyViolations(
      [subject],
      subject.workspaceNames,
      {
        safeHostDependencyExports: {},
        peerRequiredHostExports: {
          '@deepseek-ai/dsh-runtime': ['runtimeValue'],
        },
      },
    )).toEqual([])

    repairPackageDependencyManifest(subject)
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.peerDependencies).toMatchObject({
      [CORDIS]: 'workspace:^',
      '@deepseek-ai/dsh-runtime': 'workspace:^',
    })
    expect(manifest.devDependencies).toMatchObject({
      [CORDIS]: 'workspace:^',
      '@deepseek-ai/dsh-runtime': 'workspace:^',
    })
    expect(formatPeerRequiredRuntimeDependencies({
      facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames,
    })).toEqual([
      'verify-package-dependencies: 1 Host runtime edge(s) remain in peerDependencies because their exports require shared identity across 1 package(s):',
      '  @deepseek-ai/dsh-probe -> @deepseek-ai/dsh-runtime: @deepseek-ai/dsh-runtime#runtimeValue',
    ])
  })

  it('reports wrong sections, workspace ranges, and stale peer metadata', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: { '@deepseek-ai/dsh-types': 'workspace:*' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-runtime': 'workspace:^' },
      peerDependencies: { [CORDIS]: 'workspace:*', '@deepseek-ai/dsh-runtime': 'workspace:^' },
      peerDependenciesMeta: { '@deepseek-ai/dsh-missing': { optional: true } },
    }
    const state = {
      facts: [facts(manifest)], packages: [], policyViolations: [], workspaceNames: facts(manifest).workspaceNames,
    }
    const violations = collectPackageDependencyViolations(state)
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('@deepseek-ai/dsh-runtime'),
      expect.stringContaining('@deepseek-ai/dsh-types'),
      expect.stringContaining(`${CORDIS} must be matching peerDependencies + devDependencies`),
      expect.stringContaining('dependencies.@deepseek-ai/dsh-types must use workspace:^'),
      expect.stringContaining('peerDependenciesMeta.@deepseek-ai/dsh-missing has no matching'),
    ]))
  })

  it('repairs owned relationships without changing unrelated dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-dependencies-'))
    roots.push(root)
    const manifestPath = 'package.json'
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: { '@deepseek-ai/schemastery': 'workspace:*', external: '^1.0.0' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-runtime': 'workspace:^' },
      peerDependencies: {
        [CORDIS]: 'workspace:^',
        '@deepseek-ai/dsh-runtime': 'workspace:^',
        '@deepseek-ai/dsh-stale': 'workspace:^',
      },
      peerDependenciesMeta: { '@deepseek-ai/dsh-stale': { optional: true } },
    }
    writeFileSync(join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
    const subject = { ...facts(manifest), manifestPath }
    const state = { facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames }

    expect(fixPackageDependencies(root, state)).toEqual([manifestPath])
    const fixed = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as PackageDependencyManifest
    expect(fixed.dependencies).toEqual({
      '@deepseek-ai/schemastery': 'workspace:^',
      external: '^1.0.0',
      '@deepseek-ai/dsh-runtime': 'workspace:^',
    })
    expect(fixed.devDependencies).toEqual({
      [CORDIS]: 'workspace:^',
      '@deepseek-ai/dsh-types': 'workspace:^',
      '@deepseek-ai/dsh-stale': 'workspace:^',
    })
    expect(fixed.peerDependencies).toEqual({ [CORDIS]: 'workspace:^' })
    expect(fixed.peerDependenciesMeta).toBeUndefined()
  })

  it('repairs an in-memory manifest for benchmark simulation', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      peerDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-runtime': 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-runtime': 'workspace:^' },
    }
    repairPackageDependencyManifest(facts(manifest))
    expect(manifest.dependencies).toEqual({ '@deepseek-ai/dsh-runtime': 'workspace:^' })
    expect(manifest.peerDependencies).toEqual({ [CORDIS]: 'workspace:^' })
  })
})
