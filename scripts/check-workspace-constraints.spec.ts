/** Workspace dependency ranges and package publication constraints. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  isPublicExperimentalPackageDirectory,
  PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
  EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS,
} from './experimental-package-policy.ts'
import {
  checkDshFamilyVersion,
  checkWorkspaceManifest,
  checkWorkspaceProtocol,
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkExperimentalNameExceptions,
  detailDocumentFiles,
  expectedDshPackageFiles,
  readWorkspaceManifests,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental = {
  dir: 'packages/experimental/prototype',
  manifest: {
    name: '@deepseek-ai/dsh-experimental-prototype',
    publishConfig: { access: 'public' },
  },
} satisfies WorkspaceManifest

describe('workspace dependency ranges', () => {
  const dependency = { dir: 'packages/core/runtime', manifest: { name: '@deepseek-ai/dsh-runtime' } }
  const cli = { dir: 'apps/cli', manifest: { name: '@deepseek-ai/dsh' } }
  const vendor = { dir: 'vendor/cordis', manifest: { name: '@deepseek-ai/cordis' } }
  const native = { dir: 'native/system', manifest: { name: '@deepseek-ai/node-addon-system' } }
  const platform = { dir: 'native/system/packages/darwin-arm64', manifest: { name: '@deepseek-ai/node-addon-system-darwin-arm64' } }
  const unrelated = { dir: 'tools/helper', manifest: { name: '@other/helper' } }

  describe.each([
    '.', 'packages/core/probe', 'packages/experimental/probe', 'apps/cli', 'apps/web',
    'apps/desktop', 'apps/desktop-host', 'benchmarks', 'website', 'python/sdk-runtime', 'tools/probe',
    'vendor/loader', 'native/system', 'native/system/packages/entry',
  ])('consumer %s', (dir) => {
    it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)(
      'requires exact DSH and tilde vendor/native %s independently of the consumer name',
      (section) => {
        const consumer = (name: string, range: string): WorkspaceManifest => ({
          dir, manifest: { name: 'consumer', [section]: { [name]: range } },
        })
        const check = (name: string, range: string): string[] =>
          checkWorkspaceProtocol([dependency, cli, vendor, native, platform, unrelated, consumer(name, range)])
        for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-runtime']) {
          expect(check(name, 'workspace:*')).toEqual([])
          for (const range of ['workspace:^', 'workspace:~', 'workspace:^0.1.7', '^0.1.7', '*']) {
            expect(check(name, range)).toEqual([
              `consumer: ${section}.${name} must use workspace:*, got ${range}`,
            ])
          }
        }
        for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/node-addon-system', '@deepseek-ai/node-addon-system-darwin-arm64']) {
          expect(check(name, 'workspace:~')).toEqual([])
          for (const range of ['workspace:*', 'workspace:^', '^4.0.3', '~4.0.3']) {
            expect(check(name, range)).toEqual([
              `consumer: ${section}.${name} must use workspace:~, got ${range}`,
            ])
          }
        }
        for (const range of ['workspace:*', 'workspace:^']) {
          expect(check('@other/helper', range)).toEqual([])
        }
        expect(check('@other/helper', '^0.1.0')).toEqual([
          `consumer: ${section}.@other/helper must use the workspace: protocol, got ^0.1.0`,
        ])
        expect(check('external', '^1.2.3')).toEqual([])
      },
    )
  })
})

describe('workspace manifest discovery', () => {
  it('checks root, app, runtime, tooling, and newly declared members while honoring exclusions', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-workspace-ranges-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const consumers = ['.', 'apps/cli', 'apps/web', 'apps/desktop', 'apps/desktop-host', 'benchmarks', 'website', 'python/sdk-runtime', 'tools/probe']
    writeFileSync(join(root, 'pnpm-workspace.yaml'), [
      'packages:', '  - packages/*/*', '  - apps/*', '  - apps/cli', '  - benchmarks',
      '  - website', '  - python/sdk-runtime', '  - tools/*', '  - "!tools/excluded"',
    ].join('\n'))
    for (const dir of [...consumers, 'tools/excluded', 'unlisted/probe', 'packages/core/runtime']) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(dir === 'packages/core/runtime'
        ? { name: '@deepseek-ai/dsh-runtime' }
        : { dependencies: { '@deepseek-ai/dsh-runtime': 'workspace:^' } }))
    }
    const manifests = readWorkspaceManifests(root)
    expect(manifests.map(entry => entry.dir).sort()).toEqual([...consumers, 'packages/core/runtime'].sort())
    expect(checkWorkspaceProtocol(manifests).sort()).toEqual(consumers.map(dir =>
      `${dir}: dependencies.@deepseek-ai/dsh-runtime must use workspace:*, got workspace:^`).sort())
  })

  it.each(['', 'null', '{}', 'packages: []', 'packages: [false]', 'packages: [""]', 'packages: wrong'])(
    'rejects an invalid workspace declaration: %s', (contents) => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-workspace-ranges-'))
      onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
      writeFileSync(join(root, 'pnpm-workspace.yaml'), contents)
      expect(() => readWorkspaceManifests(root)).toThrow('packages must be a non-empty list of workspace patterns')
    },
  )

  it('rejects a declaration that matches no workspace members', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-workspace-ranges-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: [missing/*]')
    expect(() => readWorkspaceManifests(root)).toThrow('packages matched no workspace manifests')
  })
})

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-" or match its declared directory exception',
    ])
  })

  it.each(Object.entries(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS))('retains %s only at its declared directory', (dir, name) => {
    expect(checkExperimentalManifest({ dir, manifest: { name, publishConfig: { access: 'public' } } })).toEqual([])
    expect(checkExperimentalManifest({ ...experimental, manifest: { ...experimental.manifest, name } }))
      .toEqual([expect.stringContaining('declared directory exception')])
  })

  it('rejects a missing manifest name even when the directory has no exception', () => {
    expect(checkExperimentalManifest({ ...experimental, manifest: { publishConfig: { access: 'public' } } }))
      .toEqual([expect.stringContaining('experimental package name must start')])
  })

  it('rejects stale, moved and duplicated retained-name declarations', () => {
    const manifests = Object.entries(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS).map(([dir, name]) => ({ dir, manifest: { name } }))
    expect(checkExperimentalNameExceptions(manifests)).toEqual([])
    const [first, ...rest] = manifests
    for (const invalid of [
      rest,
      [{ ...first!, manifest: { name: '@deepseek-ai/dsh-experimental-replacement' } }, ...rest],
      [{ ...first!, dir: 'packages/core/replacement' }, ...rest],
      [...manifests, { ...first!, dir: 'packages/experimental/duplicate' }],
    ]) expect(checkExperimentalNameExceptions(invalid)).toEqual([expect.stringContaining(first!.manifest.name)])
  })

  it.each(Object.values(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS))('rejects retained runtime names and aliases: %s', (name) => {
    for (const dependencies of [{ [name]: 'workspace:*' }, { alias: `npm:${name}@1.0.0` }, { alias: `workspace:${name}@*` }]) {
      expect(checkExperimentalDependencyIsolation([{
        dir: 'apps/cli', manifest: { name: '@deepseek-ai/dsh', dependencies },
      }], [])).toEqual([expect.stringContaining('must not reference an experimental package')])
    }
  })

  it('requires public metadata for unlisted experimental packages', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { name: experimental.manifest.name, private: true },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: public experimental package must not set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: public experimental package must set publishConfig.access to "public"',
    ])
  })

  it('requires private metadata for an explicitly excluded prototype', () => {
    const { dir, manifest: { name } } = experimental
    const privateDirectories = [dir]
    expect(isPublicExperimentalPackageDirectory(dir, privateDirectories)).toBe(false)
    expect(checkExperimentalManifest({ dir, manifest: { name, private: true } }, privateDirectories)).toEqual([])
    expect(checkExperimentalManifest(experimental, privateDirectories)).toEqual([
      `${name}: experimental package must set "private": true`,
      `${name}: experimental package must omit publishConfig`,
    ])
  })

  it('keeps the current experimental publication set unrestricted', () => {
    expect(PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES).toEqual([])
  })

  it('limits the public default to experimental package directories', () => {
    expect(isPublicExperimentalPackageDirectory(experimental.dir)).toBe(true)
    for (const dir of [
      'packages/core/session',
      'apps/cli',
      'vendor/cordis',
      'packages/experimental',
      'packages/experimental/prototype/src',
      ...PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
    ]) {
      expect(isPublicExperimentalPackageDirectory(dir)).toBe(false)
    }
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows the dsh installation to ship the optional bundles the launcher names, and nothing else experimental', () => {
    const listed = { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' }
    const installation = { dir: 'apps/cli', manifest: { name: '@deepseek-ai/dsh', dependencies: listed } } satisfies WorkspaceManifest
    expect(checkExperimentalDependencyIsolation([experimental, installation], ['@deepseek-ai/dsh-experimental-prototype'])).toEqual([])
    expect(checkExperimentalDependencyIsolation([experimental, installation], [])).toEqual([
      '@deepseek-ai/dsh: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
    // Only a plain dependency edge is offered; a peer would make the bundle a requirement of every consumer.
    expect(checkExperimentalDependencyIsolation([experimental, {
      dir: 'apps/cli',
      manifest: { name: '@deepseek-ai/dsh', peerDependencies: listed },
    }], ['@deepseek-ai/dsh-experimental-prototype'])).toEqual([
      '@deepseek-ai/dsh: peerDependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('dsh family version coherence', () => {
  it('rejects a package carrying a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh-http-proxy: package.json version must match root version 0.1.2-rc.1')
  })

  it('rejects the root-named CLI app on a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh: package.json version must match root version 0.1.2-rc.1')
  })

  it('accepts a manifest carrying the shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-rc.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
  })

  it('leaves other sequences to their own version lines', () => {
    expect(checkDshFamilyVersion({ name: '@deepseek-ai/cordis', version: '4.0.1' }, '0.1.2-rc.1')).toBeUndefined()
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/node-addon-system', version: '0.1.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
    expect(checkDshFamilyVersion({ version: '0.1.2-alpha.5' }, '0.1.2-rc.1')).toBeUndefined()
  })
})

describe('package payload constraints', () => {
  it.each([
    ['./art/icon.svg', ['art/icon.svg']],
    [{ import: './art/icon.svg', default: './art/fallback.svg' }, ['art/icon.svg', 'art/fallback.svg']],
    [['./art/icon.svg', './art/icon.svg'], ['art/icon.svg']],
  ] as const)('includes exported icon targets in the canonical payload: %j', (icon, expected) => {
    expect(expectedDshPackageFiles({ exports: { './icon': icon } })).toEqual([...expected, 'lib/index.js', 'lib/types/**/*.d.ts'])
  })

  it.each(['icon.svg', './icon.svg'])('includes and deduplicates manifest icon %s', (icon) => {
    expect(expectedDshPackageFiles({ icon, exports: { './icon': './icon.svg' } })).toEqual(['icon.svg', 'lib/index.js', 'lib/types/**/*.d.ts'])
  })

  it('includes manifest, root, and subpath icon targets', () => {
    expect(expectedDshPackageFiles({ icon: './legacy.svg', exports: { './icon': './fallback.svg', './search/icon': './search.svg' } })).toEqual([
      'legacy.svg', 'fallback.svg', 'search.svg', 'lib/index.js', 'lib/types/**/*.d.ts',
    ])
  })

  it('accepts the Agent Team icon payload and rejects its omission', () => {
    const dir = 'packages/experimental/agent-team-profile'
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files: manifest.files!.filter(file => file !== 'icon.svg') } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  })

  it.each([
    { exports: { './locale/*.json': './locale/*.json' }, resources: ['locale/*.json'] },
    { exports: { './search/locale/*.json': './resources/search/*.json' }, resources: ['resources/search/*.json'] },
    { exports: { './locale/en.json': './locale/en.json', './locale/zh.json': './locale/zh.json' }, resources: ['locale/en.json', 'locale/zh.json'] },
    { exports: { './locale/*.json': { default: './locale/*.json' } }, resources: ['locale/*.json'] },
    { exports: { './locale/*.json': './locale/*.json', './search/locale/*.json': './locale/*.json' }, resources: ['locale/*.json'] },
    { exports: { './search/locale/*.json': './z/*.json', './locale/*.json': './a/*.json' }, resources: ['a/*.json', 'z/*.json'] },
  ])('includes declared locale resources in the canonical payload: $exports', ({ exports, resources }) => {
    expect(expectedDshPackageFiles({ name: '@deepseek-ai/dsh-localized', exports })).toEqual([
      ...resources, 'lib/index.js', 'lib/types/**/*.d.ts',
    ])
  })

  it('publishes tools entry points and shared runtime chunks', () => {
    const dir = 'packages/core/tools'
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
    for (const omitted of ['lib/pipeline.js', 'lib/shared-*.js']) {
      expect(checkWorkspaceManifest({ dir, manifest: {
        ...manifest, files: manifest.files!.filter(file => file !== omitted),
      } })).toEqual([expect.stringContaining('package.json files must be')])
    }
    expect(checkWorkspaceManifest({ dir, manifest: {
      ...manifest,
      exports: {
        ...manifest.exports,
        './pipeline': { types: './lib/types/pipeline.d.ts', default: './lib/index.js' },
      },
    } })).toContainEqual(expect.stringContaining('exports["./pipeline"] must expose'))
  })

  it('publishes the directory of each locale detail document after the locale resources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-detail-files-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    mkdirSync(join(dir, 'docs/guide'), { recursive: true })
    mkdirSync(join(dir, 'locale'))
    writeFileSync(join(dir, 'docs/DETAIL.md'), '')
    writeFileSync(join(dir, 'docs/guide/DETAIL.zh.md'), '')
    writeFileSync(join(dir, 'docs/DETAIL.fr.md'), '')
    writeFileSync(join(dir, 'locale/en.json'), JSON.stringify({ meta: { title: 'T', detail: 'docs/DETAIL.md' } }))
    writeFileSync(join(dir, 'locale/zh.json'), JSON.stringify({ meta: { title: 'T', detail: 'docs/guide/DETAIL.zh.md' } }))
    writeFileSync(join(dir, 'locale/fr.json'), JSON.stringify({ meta: { title: 'T', detail: 'docs/DETAIL.fr.md' } }))
    writeFileSync(join(dir, 'locale/de.json'), JSON.stringify({ meta: { title: 'T' } }))
    writeFileSync(join(dir, 'locale/ja.json'), '{')
    const detailFiles = detailDocumentFiles(dir)
    expect(detailFiles).toEqual(['docs'])
    expect(expectedDshPackageFiles({ exports: { './locale/*.json': './locale/*.json' } }, detailFiles)).toEqual([
      'locale/*.json', 'docs', 'lib/index.js', 'lib/types/**/*.d.ts',
    ])
  })

  it('rejects a detail document that is missing, outside the package, or at the package root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-detail-invalid-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    mkdirSync(join(dir, 'locale'))
    const declare = (detail: unknown): void => {
      writeFileSync(join(dir, 'locale/en.json'), JSON.stringify({ meta: { detail } }))
    }
    declare('docs/DETAIL.md')
    expect(() => detailDocumentFiles(dir)).toThrow(/DETAIL\.md.*does not exist/)
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs/DETAIL.md'), '')
    expect(detailDocumentFiles(dir)).toEqual(['docs'])
    declare('DETAIL.md')
    expect(() => detailDocumentFiles(dir)).toThrow(/must name a file in a subdirectory/)
    declare('../DETAIL.md')
    expect(() => detailDocumentFiles(dir)).toThrow(/must be a relative path inside the package/)
    writeFileSync(join(dir, 'locale/en.json'), 'null')
    expect(detailDocumentFiles(dir)).toEqual([])
  })

  it('rejects a bundle whose locale detail document is missing from its publication files', () => {
    const dir = 'packages/experimental/badge-skill-bundle'
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', dir, 'package.json'), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
    const files = (manifest.files ?? []).filter(file => file !== 'docs')
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files } }).join('\n')).toContain('"docs"')
  })

  it('does not infer locale payloads from unrelated or non-JSON exports', () => {
    expect(expectedDshPackageFiles({
      exports: {
        './config.json': './config.json',
        './locale/README.md': './locale/README.md',
        './locale/en.json': './metadata.js',
        './locale/zh.json': null,
        './locale/fr.json': { types: './locale/fr.d.ts' },
      },
    })).toEqual(['lib/index.js', 'lib/types/**/*.d.ts'])
  })

  it.each(['agent-team', 'agent-team-profile', 'auto-review', 'client-ui-agent-team', 'tool-agent-team'])(
    'accepts the published locale files for %s and rejects their omission', (name) => {
      const dir = `packages/experimental/${name}`
      const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
      expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
      expect(checkWorkspaceManifest({ dir, manifest: {
        ...manifest, files: manifest.files!.filter(file => file !== 'locale/*.json'),
      } })).toEqual([expect.stringContaining('package.json files must be')])
    },
  )

  it('exempts the private plugin market generator from release rules in its own directory only', () => {
    const dir = 'apps/plugin-market-generator'
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
    expect(checkWorkspaceManifest({ dir: 'apps/other-tool', manifest })).not.toEqual([])
  })

  it('rejects locale publication entries without their resource exports', () => {
    const dir = 'packages/experimental/auto-review'
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    const exports = { ...manifest.exports }
    delete exports['./locale/*.json']
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, exports } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  })

  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: ['./cordis.patch.yml', './layers/web.patch.yml'] } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'layers/web.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })

  it.each([
    'packages/client/ui-sidebar-documentpreview',
    'packages/client/ui-sidebar-terminal',
  ])('accepts package-local Client chunks from %s', (dir) => {
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  })

  it.each([
    { './assets/*': './lib/assets/*' },
    { './assets/*': { default: './lib/assets/*' } },
  ])('publishes built package assets after the browser Client entries: %j', (assets) => {
    expect(expectedDshPackageFiles({
      exports: {
        './client': { types: './lib/types/client/index.d.ts', node: './lib/client.node.js', default: './lib/client.js' },
        './loader': './lib/loader.js',
        ...assets,
      },
    })).toEqual([
      'lib/index.js', 'lib/client.js', 'lib/client.node.js', 'lib/assets', 'lib/loader.js', 'lib/types/**/*.d.ts',
    ])
  })

  it.each([
    {},
    { './assets/*': './assets/*' },
    { './assets/*': { types: './lib/assets/*' } },
    { './assets/extra': './lib/assets/*' },
  ])('does not publish package assets without the exact asset export target: %j', (assets) => {
    expect(expectedDshPackageFiles({ exports: { './client': './lib/client.js', ...assets } }))
      .toEqual(['lib/index.js', 'lib/client.js', 'lib/types/**/*.d.ts'])
  })

  it('rejects a package-asset export whose payload omits the built assets', () => {
    const dir = 'packages/client/probe'
    const manifest = {
      name: '@deepseek-ai/dsh-client-probe',
      type: 'module',
      main: 'lib/index.js',
      types: 'lib/types/index.d.ts',
      exports: {
        '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
        './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' },
        './assets/*': './lib/assets/*',
      },
      files: ['lib/index.js', 'lib/client.js', 'lib/assets', 'lib/types/**/*.d.ts'],
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:~' },
      devDependencies: { '@deepseek-ai/cordis': 'workspace:~' },
    } satisfies WorkspaceManifest['manifest']
    const payloadErrors = (candidate: WorkspaceManifest['manifest']): string[] =>
      checkWorkspaceManifest({ dir, manifest: candidate }).filter(error => error.includes('package.json files must be'))
    expect(payloadErrors(manifest)).toEqual([])
    expect(payloadErrors({ ...manifest, files: manifest.files.filter(file => file !== 'lib/assets') })).toEqual([
      expect.stringContaining('@deepseek-ai/dsh-client-probe: package.json files must be '
        + '["lib/index.js","lib/client.js","lib/assets","lib/types/**/*.d.ts"]'),
    ])
  })

  it.each(['ui-chat', 'ui-settings-account'])(
    'accepts the published package assets for %s and rejects their omission', (name) => {
      const dir = `packages/client/${name}`
      const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
      expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
      expect(checkWorkspaceManifest({ dir, manifest: {
        ...manifest, files: manifest.files!.filter(file => file !== 'lib/assets'),
      } })).toEqual([expect.stringContaining('package.json files must be')])
    },
  )
})

it('publishes CLI runtime declarations and rejects a payload that omits them', () => {
  const manifest = JSON.parse(readFileSync(new URL('../apps/cli/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'apps/cli', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'apps/cli', manifest: { ...manifest, files: ['lib/*.js'] } }))
    .toEqual([expect.stringContaining('@deepseek-ai/dsh: package.json files must be ["lib/*.js","lib/types/*.d.ts"]')])
})

it('requires the shared Web injection entry in the published payload', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/client/web/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'packages/client/web', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'packages/client/web', manifest: {
    ...manifest, files: ['lib/index.js', 'lib/**/*.css', 'lib/types/**/*.d.ts'],
  } })).toEqual([expect.stringContaining('package.json files must be')])
})

it('requires Office skill bodies and helpers in the published payload', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/skill/skill-office/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'packages/skill/skill-office', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'packages/skill/skill-office', manifest: {
    ...manifest, files: ['lib/index.js', 'lib/types/**/*.d.ts'],
  } })).toEqual([expect.stringContaining('package.json files must be')])
})

it('requires the local speech worker and locked runtime in the published payload', () => {
  const dir = 'packages/experimental/speech-to-text-sensevoice'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const omitted of ['lib/worker.js', 'runtime/assets.json']) {
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files: manifest.files!.filter(file => file !== omitted) } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
})

it('requires Node profile configuration and both execution bootstraps in the published payload', () => {
  const dir = 'packages/ptc-runtime/ptc-runtime-node'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const omitted of ['lib/configuration.js', 'lib/process.js', 'lib/persistent-process.js']) {
    const files = expectedDshPackageFiles(manifest).filter(file => file !== omitted)
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
})

it('requires the Inspector Worker, Client chunks, and mirrored DevTools resources in the published payload', () => {
  const dir = 'packages/experimental/inspector'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const omitted of ['lib/client.*.js', 'lib/worker.js', 'lib/devtools/**']) {
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files: manifest.files!.filter(file => file !== omitted) } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
})

it('requires both physical Client entries only for opted-in packages', () => {
  for (const dir of ['packages/client/connection', 'packages/api/gateway', 'packages/typert/registry']) {
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
    for (const omitted of ['lib/client.node.js', 'lib/client.browser.js']) {
      const files = manifest.files!.filter(file => file !== omitted)
      expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files } }))
        .toEqual([expect.stringContaining('package.json files must be')])
    }
  }
})

it('requires the standalone shortcut protocol and rejects unrelated runtime files', () => {
  const dir = 'packages/client/shortcuts'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const files of [
    ['lib/index.js', 'lib/client.js', 'lib/types/**/*.d.ts'],
    ['lib/index.js', 'lib/client.js', 'lib/protocol.js', 'lib/extra.js', 'lib/types/**/*.d.ts'],
  ]) {
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
})

it('requires the OAR license while rejecting unrelated payload files', () => {
  const dir = 'packages/experimental/subagent-oar'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  const files = [
    'icon.svg', 'locale/*.json', 'lib/index.js',
    'LICENSE-OAR', 'lib/types/**/*.d.ts',
  ]
  expect(expectedDshPackageFiles(manifest)).toEqual(files)
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const invalidFiles of [
    files.filter(file => file !== 'LICENSE-OAR'),
    [...files, 'lib/unrelated.js'],
  ]) {
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files: invalidFiles } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
})
