/** Source, installation, and composition regressions for default-product isolation. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyDefaultProductIsolation } from './verify-default-product-isolation.ts'

const roots: string[] = []
const experimental = '@deepseek-ai/dsh-experimental-prototype'
const core = '@deepseek-ai/dsh-core'
const base = '@deepseek-ai/dsh-base'
const profile = 'packages/boot/app-boot/src/profile.ts'
const preset = 'packages/bundle/web-app/presets/standard.patch.yml'
const patch = 'packages/bundle/base/cordis.patch.yml'

function write(root: string, path: string, value: unknown): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}

function manifest(root: string, path: string, fields: Record<string, unknown>): void {
  const existing = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>
  write(root, path, { ...existing, ...fields })
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh.default-isolation-'))
  roots.push(root)
  write(root, 'apps/cli/package.json', { name: '@deepseek-ai/dsh', dependencies: { [core]: 'workspace:^' } })
  write(root, 'apps/cli/src/bin.ts', 'export {}\n')
  write(root, 'apps/web/package.json', { name: '@deepseek-ai/dsh-web-frontend' })
  write(root, 'apps/web/index.html', '<script type="module" src="/src/main.ts"></script>')
  write(root, 'apps/web/src/main.ts', 'export {}\n')
  write(root, 'python/sdk-runtime/package.json', { name: '@deepseek-ai/dsh-python-runtime' })
  write(root, 'packages/core/core/package.json', { name: core })
  write(root, 'packages/core/core/src/index.ts', 'export {}\n')
  write(root, 'packages/bundle/base/package.json', { name: base, dsh: { bundle: { patch: './cordis.patch.yml' } } })
  write(root, patch, [{ insert: [{ name: core }] }])
  write(root, preset, [{ insert: [{ name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', plugins: [{ name: core }] } }] }])
  write(root, 'packages/preset/agent-preset/package.json', { name: '@deepseek-ai/dsh-agent-preset' })
  write(root, profile, `export const PROFILE_TEMPLATES = { web: { bundles: ['${base}'] } }\n`
    + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`)
  write(root, 'packages/experimental/prototype/package.json', { name: experimental })
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('default product isolation', () => {
  it.each(['@deepseek-ai/libreoffice-kit'])(
    'accepts independently published %s but rejects unknown workspace packages', (name) => {
      const root = fixture()
      const file = 'packages/core/core/package.json'
      write(root, 'packages/core/core/src/index.ts', `import '${name}'\n`)
      manifest(root, file, { dependencies: { [name]: '0.0.1' } })
      expect(verifyDefaultProductIsolation(root).failures).toEqual([])
      manifest(root, file, { dependencies: { [`${name}-unknown`]: '0.0.1' } })
      expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain('unknown workspace package')
    },
  )

  it.each(['wasm', 'darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'])(
    'rejects a direct dependency on the %s engine', (engine) => {
      const root = fixture()
      const name = `@deepseek-ai/libreoffice-kit-${engine}`
      manifest(root, 'packages/core/core/package.json', { dependencies: { [name]: '0.0.1' } })
      expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`unknown workspace package ${name}`)
    },
  )

  it('allows development dependencies, type imports, and separate experimental preview entries', () => {
    const root = fixture()
    manifest(root, 'apps/cli/package.json', { devDependencies: { [experimental]: 'workspace:^' } })
    write(root, 'apps/cli/src/bin.ts', `import type { Options } from '${experimental}'\nexport type { Options }\n`)
    write(root, 'apps/web/src/preview.ts', `import '${experimental}'\n`)
    write(root, 'packages/experimental/prototype/cordis.patch.yml', [{ name: experimental }])

    expect(verifyDefaultProductIsolation(root)).toMatchObject({ failures: [], packageCount: 6, configCount: 2 })
  })

  it('ignores dependency trees and directories whose names end in a source extension', () => {
    const root = fixture()
    mkdirSync(join(root, 'python/sdk-runtime/src/vendor.js'), { recursive: true })
    write(root, 'python/sdk-runtime/src/node_modules/vendor/index.js', `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures).toEqual([])
  })

  it('ships an optional bundle switched off: its graph is outside the product, its name stays out of imports and defaults', () => {
    const root = fixture()
    const layer = '@deepseek-ai/dsh-experimental-layer'
    write(root, 'packages/experimental/layer/package.json', {
      name: layer, icon: './icon.svg', exports: { './locale/*.json': './locale/*.json' },
      dependencies: { [experimental]: 'workspace:^' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    write(root, 'packages/experimental/layer/cordis.patch.yml', [{ insert: [{ name: experimental }] }])
    manifest(root, 'apps/cli/package.json', { dependencies: { [core]: 'workspace:^', [layer]: 'workspace:^' } })
    write(root, profile, `export const PROFILE_TEMPLATES = { web: { bundles: ['${base}'] } }\n`
      + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`
      + `export const OPTIONAL_BUNDLES = ['${layer}']\n`)
    expect(verifyDefaultProductIsolation(root)).toMatchObject({ failures: [], packageCount: 6 })

    // The exception covers the dependency edge alone: a runtime import or a default template still names the product.
    write(root, 'apps/cli/src/bin.ts', `import '${layer}'\n`)
    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`apps/cli/src/bin.ts -> ${layer}`)
    write(root, 'apps/cli/src/bin.ts', 'export {}\n')
    write(root, profile, `export const PROFILE_TEMPLATES = { web: { bundles: ['${base}', '${layer}'] } }\n`
      + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`
      + `export const OPTIONAL_BUNDLES = ['${layer}']\n`)
    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`optional bundle ${layer} must not be a default bundle`)
  })

  it('requires each optional bundle to be a runtime dependency that declares a bundle patch, an icon, and locale metadata', () => {
    const root = fixture()
    write(root, profile, `export const PROFILE_TEMPLATES = { web: { bundles: ['${base}'] } }\n`
      + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`
      + `export const OPTIONAL_BUNDLES = ['${experimental}']\n`)
    const failures = verifyDefaultProductIsolation(root).failures.join('\n')
    expect(failures).toContain(`optional bundle ${experimental} must be a runtime dependency of apps/cli`)
    expect(failures).toContain(`optional bundle ${experimental} must declare dsh.bundle.patch`)
    expect(failures).toContain(`optional bundle ${experimental} must declare an icon`)
    expect(failures).toContain(`optional bundle ${experimental} must export ./locale/*.json display metadata`)

    // An experimental runtime dependency the list does not name is still a product requirement.
    write(root, profile, `export const PROFILE_TEMPLATES = { web: { bundles: ['${base}'] } }\n`
      + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`)
    manifest(root, 'apps/cli/package.json', { dependencies: { [core]: 'workspace:^', [experimental]: 'workspace:^' } })
    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`@deepseek-ai/dsh dependencies -> ${experimental}`)
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'rejects transitive experimental %s',
    (section) => {
      const root = fixture()
      manifest(root, 'packages/core/core/package.json', { [section]: { [experimental]: 'workspace:^' } })

      expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`${core} ${section} -> ${experimental}`)
    },
  )

  it.each([
    `npm:${experimental}@1.0.0`, `workspace:${experimental}@*`,
    'file:../../experimental/prototype', 'link:../../experimental/prototype',
    'workspace:../../experimental/prototype',
  ])('rejects a safe-looking dependency alias targeting %s', (range) => {
    const root = fixture()
    manifest(root, 'packages/core/core/package.json', { dependencies: { safe: range } })

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('rejects experimental names absent from the inventory and paths with another package name', () => {
    const root = fixture()
    manifest(root, 'apps/cli/package.json', { dependencies: { '@deepseek-ai/dsh-experimental-missing': '*' } })
    manifest(root, 'packages/experimental/prototype/package.json', { name: '@fixture/innocent' })
    manifest(root, 'python/sdk-runtime/package.json', { dependencies: { '@fixture/innocent': '*' } })

    const failures = verifyDefaultProductIsolation(root).failures.join('\n')
    expect(failures).toContain('@deepseek-ai/dsh-experimental-missing')
    expect(failures).toContain('@fixture/innocent')
  })

  it('follows private application intermediaries and terminates cycles', () => {
    const root = fixture()
    write(root, 'apps/desktop/package.json', { name: '@fixture/desktop', private: true,
      dependencies: { [core]: '*', [experimental]: '*' } })
    manifest(root, 'packages/core/core/package.json', { peerDependencies: { '@fixture/desktop': '*' } })

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([
    `import '${experimental}'`,
    `export * from '${experimental}'`,
    `await import('${experimental}/client')`,
    `const x = require('${experimental}')`,
    'import \'./../../../packages/experimental/prototype/src/index.ts\'',
  ])('rejects runtime source reference %s', (source) => {
    const root = fixture()
    write(root, 'apps/cli/src/bin.ts', source)
    write(root, 'packages/experimental/prototype/src/index.ts', 'export {}\n')

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([
    "import './preview.ts'", "import './preview.ts?worker'", "new Worker(new URL('./preview.ts', import.meta.url))",
  ])('rejects default Web entry reaching preview via %s', (source) => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', source)
    write(root, 'apps/web/src/preview.ts', `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([
    "import '/src/preview.ts'",
    "export * from '/src/preview.ts'",
    "await import('/src/preview.ts')",
    "new Worker(new URL('/src/preview.ts', import.meta.url))",
  ])('follows Web-root runtime reference %s', (source) => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', source)
    write(root, 'apps/web/src/preview.ts', `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('does not follow type-only Web-root references', () => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', "import type { Value } from '/src/preview.ts'\nexport type { Value } from '/src/preview.ts'\n")
    write(root, 'apps/web/src/preview.ts', `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures).toEqual([])
  })

  it.each(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts'])('follows extensionless Web imports to %s in a dotted checkout', (extension) => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', "import './preview'\n")
    write(root, `apps/web/src/preview${extension}`, `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each(['.js', '.jsx', '.mjs'])('follows Web directory imports to index%s', (extension) => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', "import './preview'\n")
    write(root, `apps/web/src/preview/index${extension}`, `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([['.mjs', '.mts'], ['.cjs', '.cts']])('follows %s runtime requests to their %s source', (request, source) => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', `import './preview${request}'\n`)
    write(root, `apps/web/src/preview${source}`, `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('follows a Web directory import whose directory name contains a dot', () => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', "import './preview.v1'\n")
    write(root, 'apps/web/src/preview.v1/index.js', `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('identifies a relative package-directory import using its exact directory owner', () => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', "import '../../../packages/experimental/prototype'\n")
    manifest(root, 'packages/experimental/prototype/package.json', { main: 'src/entry.js' })
    write(root, 'packages/experimental/prototype/src/entry.js', 'export {}\n')

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([
    [{ name: experimental, disabled: true }],
    [{ group: true, config: [{ name: experimental }] }],
    [{ insert: [{ name: experimental }] }],
    [{ name: '@deepseek-ai/cordis-plugin-group', config: [{ name: experimental }] }],
    [{ name: '@deepseek-ai/cordis-plugin-include', config: { patches: [{ insert: [{ name: experimental }] }] } }],
  ].map(entries => ({ entries })))('rejects experimental plugin rows in $entries', ({ entries }) => {
    const root = fixture()
    write(root, patch, entries)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('follows Include files while ignoring ordinary plugin config data', () => {
    const root = fixture()
    write(root, patch, [{ insert: [{ name: core, config: { name: experimental, insert: [{ name: experimental }] } }] }])
    expect(verifyDefaultProductIsolation(root).failures).toEqual([])
    write(root, patch, [{ name: '@deepseek-ai/cordis-plugin-include', config: { path: './nested.yml' } }])
    write(root, 'packages/bundle/base/nested.yml', [{ name: experimental }])
    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([false, true])('checks Include.initial when its file exists: %s', (existing) => {
    const root = fixture()
    const included = join(root, 'included.yml')
    if (existing) write(root, 'included.yml', [{ name: core }])
    write(root, patch, [{ insert: [{ name: 'cordis:include', config: {
      path: pathToFileURL(included).href,
      initial: [{ name: experimental }],
    } }] }])

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('accepts a missing Include file initialized with stable entries and applies its patches', () => {
    const root = fixture()
    write(root, patch, [{ insert: [{ name: 'cordis:include', config: {
      path: pathToFileURL(join(root, 'included.yml')).href,
      initial: [{ id: 'feature', group: true, config: [{ name: core }] }],
    } }] }])
    expect(verifyDefaultProductIsolation(root).failures).toEqual([])
    write(root, patch, [{ insert: [{ name: 'cordis:include', config: {
      path: pathToFileURL(join(root, 'included.yml')).href,
      initial: [{ id: 'feature', group: true, config: [{ name: core }] }],
      patches: [{ id: 'feature', config: [{ name: experimental }] }],
    } }] }])
    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('rejects an Include.initial tree that includes its own generated file', () => {
    const root = fixture()
    const path = pathToFileURL(join(root, 'included.yml')).href
    write(root, patch, [{ insert: [{ name: 'cordis:include', config: {
      path, initial: [{ name: 'cordis:include', config: { path } }],
    } }] }])

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain('cyclic Include path included.yml')
  })

  it('checks default profile bundle names and declared config trees', () => {
    const root = fixture()
    write(root, profile, `export const PROFILE_TEMPLATES = { web: { bundles: ['${experimental}'] } }\n`
      + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`)
    manifest(root, 'apps/cli/package.json', { dsh: { configTrees: [{ path: './config' }] } })
    write(root, 'apps/cli/config/extra.cordis.yml', [{ name: experimental }])
    const failures = verifyDefaultProductIsolation(root).failures.join('\n')
    expect(failures).toContain(`${profile} -> ${experimental}`)
    expect(failures).toContain('apps/cli/config/extra.cordis.yml')
  })

  it.each([false, true])('rejects a declared config tree without composition files when its directory exists: %s', (existing) => {
    const root = fixture()
    manifest(root, 'apps/cli/package.json', { dsh: { configTrees: [{ path: './config' }] } })
    if (existing) write(root, 'apps/cli/config/README.i18n.yaml', 'en: test\n')

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain('apps/cli/config')
  })

  it('does not classify ordinary YAML as a Cordis config because of an ancestor directory name', () => {
    const root = fixture()
    write(root, 'packages/core/core/src/cordis/index.ts', "new URL('./ordinary.yml', import.meta.url)\n")
    write(root, 'packages/core/core/src/cordis/ordinary.yml', 'ordinary: data\n')

    expect(verifyDefaultProductIsolation(root).failures).toEqual([])
  })

  it('checks desktop configuration reached through a source URL', () => {
    const root = fixture()
    write(root, 'apps/desktop-host/package.json', { name: '@fixture/desktop-host', private: true })
    write(root, 'apps/desktop-host/src/index.ts', "new URL('../config/desktop.cordis.patch.yml', import.meta.url)")
    write(root, 'apps/desktop-host/config/desktop.cordis.patch.yml', [{ insert: [{ name: experimental }] }])

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('checks group contents after an id-only patch changes the composed Web tree', () => {
    const root = fixture()
    const web = '@deepseek-ai/dsh-web-app'
    write(root, 'packages/bundle/web-app/package.json', { name: web, dsh: { bundle: { patch: './cordis.patch.yml' } } })
    write(root, patch, [{ insert: [{ id: 'feature-group', group: true, config: [{ name: core }] }] }])
    write(root, 'packages/bundle/web-app/cordis.patch.yml', [
      { id: 'feature-group', config: [{ name: experimental }] },
    ])
    write(root, profile, `export const PROFILE_TEMPLATES = { web: { bundles: ['${base}', '${web}'] } }\n`
      + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`${profile} -> ${experimental}`)
  })

  it('composes Include patches before checking their effective plugin rows', () => {
    const root = fixture()
    const included = join(root, 'included tree', 'cordis.yml')
    write(root, 'included tree/cordis.yml', [{ id: 'feature-group', group: true, config: [{ name: core }] }])
    write(root, patch, [{ insert: [{ name: 'cordis:include', config: {
      path: pathToFileURL(included).href,
      patches: [{ id: 'feature-group', config: [{ name: experimental }] }],
    } }] }])

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`included tree/cordis.yml -> ${experimental}`)
  })

  it('checks the replacement Include path after an id-only Web patch', () => {
    const root = fixture()
    write(root, 'original.yml', [{ name: core }])
    write(root, 'replacement.yml', [{ name: experimental }])
    write(root, patch, [
      { insert: [{ id: 'feature-include', name: 'cordis:include', config: { path: pathToFileURL(join(root, 'original.yml')).href } }] },
      { id: 'feature-include', config: { path: pathToFileURL(join(root, 'replacement.yml')).href } },
    ])

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`replacement.yml -> ${experimental}`)
  })

  it('reports an empty effective Web tree even when the raw patch names a package', () => {
    const root = fixture()
    write(root, patch, [{ id: 'missing-target', name: core }])

    expect(verifyDefaultProductIsolation(root).failures).toContain(`${profile}: composed Web profile contains no plugins`)
  })

  it('rejects a file-URL plugin name anchored by the real patch loader', () => {
    const root = fixture()
    write(root, patch, [{ insert: [{ name: '../../experimental/prototype/src/index.ts' }] }])
    write(root, 'packages/experimental/prototype/src/index.ts', 'export {}\n')

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`${profile} -> ${experimental}`)
  })

  it('checks installation-owned profile tuples as well as new-profile defaults', () => {
    const root = fixture()
    const source = readFileSync(join(root, profile), 'utf8')
    write(root, profile, `${source}\nconst INSTALLATION_OWNED_PROFILE_TUPLES = { headless: ['${experimental}'] }\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('checks inline modules alongside the default Web script', () => {
    const root = fixture()
    write(root, 'apps/web/index.html', '<script type="module" src="/src/main.ts"></script>'
      + `<script type="module">import '${experimental}'</script>`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each(['apps/cli/package.json', 'apps/web/index.html', 'python/sdk-runtime/package.json', preset])(
    'fails closed when required input %s is missing',
    (path) => {
      const root = fixture()
      rmSync(join(root, path))
      expect(verifyDefaultProductIsolation(root).failures.length).toBeGreaterThan(0)
    },
  )

  it.each([
    '',
    'export const PROFILE_TEMPLATES = {}; export const DEFAULT_PROFILE_BUNDLES = []',
    'export const PROFILE_TEMPLATES = computedProfiles(); export const DEFAULT_PROFILE_BUNDLES = []',
  ])('rejects absent, empty, or uninspectable default profile definitions', (source) => {
    const root = fixture()
    write(root, profile, source)
    expect(() => verifyDefaultProductIsolation(root)).toThrow('profile')
  })
})
