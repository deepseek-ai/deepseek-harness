/**
 * Pins shared client-bundle preset rules: module-edge purity, source-map
 * chaining, and physical watch dependencies hidden behind virtual CSS Modules.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type TsdownBundle, type UserConfig } from 'tsdown'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { clientBundle, requestedExternals, staticLinked } from '../packages/client/tsdown.client.ts'

type ResolveId = (source: string) => null | { id: string; external: boolean }

interface CssModulePlugin {
  name: string
  resolveId?: (source: string, importer: string | undefined) => null | string
  load?: (this: { addWatchFile: (id: string) => void }, id: string) => Promise<unknown>
}

interface SourceMapPlugin {
  name: string
  load?: (id: string) => Promise<unknown>
}

interface InputIsolationPlugin {
  name: string
  generateBundle: (this: {
    getModuleInfo(id: string): { importedIds: string[]; dynamicallyImportedIds: string[] } | null
  }, options: unknown, bundle: Record<string, {
      type: 'chunk'
      modules: Record<string, object>
      imports: string[]
      dynamicImports: string[]
    }>) => void
}

/** A representative dynamic bundle using the shared client baseline. */
const REQUESTING_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'

function clientConfigs(id = REQUESTING_PACKAGE) {
  return clientBundle(id, ['lib/types/index.js', 'lib/types/invariant.js'])(
    { env: { DSH_BUILD_FACE: 'client' } },
  ).filter(config => config.platform === 'browser')
}

describe('client bundle build faces', () => {
  it('watches source in development and consumes emitted JavaScript in the Client build', () => {
    const bundle = clientBundle('@deepseek-ai/dsh-client-test', ['lib/types/index.js'])
    const development = bundle({ env: {} }).find(config => config.platform === 'browser')
    const artifact = bundle({ env: { DSH_BUILD_FACE: 'client' } })
      .find(config => config.platform === 'browser')

    expect(development?.entry).toEqual({ client: 'src/client/index.ts' })
    expect(artifact?.entry).toEqual({ client: 'lib/types/client/index.js' })
  })
})

describe('client bundle dynamic imports', () => {
  it('compiles import() to the module loader asynchronous operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-client-dynamic-import-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const entry = join(root, 'lib/types/client/index.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: REQUESTING_PACKAGE, type: 'module' }))
    writeFileSync(entry, 'export const load = () => import("./terminal.js")\n')
    writeFileSync(join(dirname(entry), 'terminal.js'), 'export const marker = "terminal"\n')
    const config = clientConfigs()[0]
    if (config === undefined) throw new Error('client config missing')

    let builds: TsdownBundle[] = []
    try {
      builds = await build({
        ...config, cwd: root, config: false, tsconfig: false,
        write: false, clean: false, exports: false, report: false, logLevel: 'silent',
      })
      const chunks = builds.flatMap(bundle => bundle.chunks).filter(chunk => chunk.type === 'chunk')
      const output = chunks.find(chunk => chunk.fileName === 'client.js')?.code
      expect(output).toContain('require.async("./client.terminal.js")')
      expect(output).not.toContain('Promise.resolve().then(() => require("./client.terminal.js"))')
    } finally {
      for (const bundle of builds) await bundle[Symbol.asyncDispose]()
    }
  })
})

function clientSourceMapPath(packagePath: string): string {
  return fileURLToPath(new URL(`../packages/${packagePath}/lib/client.js.map`, import.meta.url))
}

function purityResolveId(id = REQUESTING_PACKAGE): ResolveId {
  // libEntry is spelled at every call site (no default) so the
  // package-invariants text check can see the invariant entry per package.
  const configs = clientConfigs(id)
  const plugins = (configs[0] as { plugins: { name: string; resolveId?: unknown }[] }).plugins
  const gate = plugins.find(p => p.name === 'dsh-client-bundle-purity')
  if (gate?.resolveId === undefined) throw new Error('purity plugin missing from client config')
  return gate.resolveId as ResolveId
}

function cssModulePlugin(): CssModulePlugin {
  const configs = clientConfigs()
  const plugins = (configs[0] as { plugins: CssModulePlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === 'dsh-css-modules-inline')
  if (plugin?.resolveId === undefined || plugin.load === undefined) {
    throw new Error('CSS Modules plugin missing from client config')
  }
  return plugin
}

function sourceMapPlugin(): SourceMapPlugin {
  const configs = clientConfigs()
  const plugins = (configs[0] as { plugins: SourceMapPlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === 'dsh-tsc-sourcemap')
  if (plugin?.load === undefined) throw new Error('tsc sourcemap plugin missing from client config')
  return plugin
}

describe('client bundle purity gate', () => {
  const resolveId = purityResolveId()

  it('leaves default externals and non-scoped specifiers alone', () => {
    expect(resolveId('@deepseek-ai/dsh-client-store')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-client-ui-slots')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-client-ui-primitives')).toBeNull()
    expect(resolveId('react')).toBeNull()
    expect(resolveId('zod')).toBeNull()
  })

  it('rejects the retired web-react platform package', () => {
    expect(() => resolveId('@deepseek-ai/dsh-client-web-react')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-client-web-react/store')).toThrow(/purity/)
  })

  it('lets inline-safe libraries inline', () => {
    expect(resolveId('@deepseek-ai/dsh-session/surface')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-brand')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-deque')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-util-values')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-token-meter/client')).toBeNull()
    expect(() => resolveId('@deepseek-ai/dsh-token-meter')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-token-meter/client/internal')).toThrow(/purity/)
    expect(resolveId('@deepseek-ai/dsh-host-open-in-app/shared')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-native-command/types')).toBeNull()
    expect(() => resolveId('@deepseek-ai/dsh-native-command')).toThrow('client bundle purity')
    expect(() => resolveId('@deepseek-ai/dsh-host-open-in-app')).toThrow(/purity/)
    expect(resolveId('@deepseek-ai/dsh-plugin-manager/registry')).toBeNull()
    expect(() => resolveId('@deepseek-ai/dsh-plugin-manager')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-plugin-manager/registry/internal')).toThrow(/purity/)
  })

  it('admits only the pure spill notice entry, not its Host policy', () => {
    expect(resolveId('@deepseek-ai/dsh-spill-policy/notice')).toBeNull()
    expect(resolveId('@deepseek-ai/dsh-output-retention')).toBeNull()
    expect(() => resolveId('@deepseek-ai/dsh-spill-policy')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-spill-policy/notice/internal')).toThrow(/purity/)
  })

  it('lets exact generated Remote contributions inline without admitting their package implementation', () => {
    expect(resolveId('@deepseek-ai/dsh-goal/remote')).toBeNull()
    expect(() => resolveId('@deepseek-ai/dsh-goal')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-goal/client')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-goal/remote/nested')).toThrow(/purity/)
  })

  it('throws on any other @deepseek-ai leak', () => {
    expect(() => resolveId('@deepseek-ai/dsh-agent')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-client-web')).toThrow(/purity/)
  })

  it('throws on cross-plugin value imports — bare plugin names and /client subpaths alike', () => {
    expect(() => resolveId('@deepseek-ai/dsh-client-connection')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-client-ui-session')).toThrow(/purity/)
    expect(() => resolveId('@deepseek-ai/dsh-client-ui-layout/client')).toThrow(/purity/)
  })

  it('admits package-specific requests only for the declaring bundle', () => {
    const requesting = purityResolveId('@deepseek-ai/dsh-api-session-controller')
    expect(requesting('@deepseek-ai/dsh-api-gateway/client')).toBeNull()
    expect(() => resolveId('@deepseek-ai/dsh-api-gateway/client')).toThrow(/purity/)
  })

  it('externalizes the baseline independently of each package manifest', () => {
    const requesting = clientConfigs()[0]?.deps as { neverBundle: (specifier: string) => boolean }
    const plain = clientConfigs('@deepseek-ai/dsh-client-connection')[0]?.deps as {
      neverBundle: (specifier: string) => boolean
    }

    expect(requesting.neverBundle('react')).toBe(true)
    expect(requesting.neverBundle('zod')).toBe(false)
    expect(plain.neverBundle('react')).toBe(true)
    expect(plain.neverBundle('@deepseek-ai/dsh-client-store')).toBe(true)
  })
})

describe('client bundle experimental input isolation', () => {
  const experimental = '@deepseek-ai/dsh-experimental-client-ui-agent-team'

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'dsh-client-inputs-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const owner = join(root, 'client')
    const entry = join(owner, 'lib/types/client/index.js')
    const prototype = join(root, 'prototype/src/index.js')
    for (const file of [entry, prototype]) mkdirSync(dirname(file), { recursive: true })
    writeFileSync(join(owner, 'package.json'), JSON.stringify({ name: REQUESTING_PACKAGE, type: 'module' }))
    writeFileSync(join(root, 'prototype/package.json'), JSON.stringify({ name: experimental, type: 'module' }))
    writeFileSync(prototype, 'export const marker = "experimental sentinel"\n')
    return { root, owner, entry, prototype }
  }

  function config(kind: 'static' | 'dynamic', id = REQUESTING_PACKAGE): UserConfig {
    const configs = kind === 'static'
      ? staticLinked(id, ['lib/types/client/index.js'])({ env: { DSH_BUILD_FACE: 'client' } })
      : clientConfigs(id)
    const browser = configs.find(config => config.platform === 'browser')
    if (browser === undefined) throw new Error('client config missing')
    return browser
  }

  async function bundle(owner: string, config: UserConfig): Promise<string> {
    let builds: TsdownBundle[] = []
    try {
      builds = await build({
        ...config, cwd: owner, config: false, tsconfig: false,
        write: false, clean: false, exports: false, report: false, logLevel: 'silent',
      })
      return builds.flatMap(build => build.chunks.filter(chunk => chunk.type === 'chunk').map(chunk => chunk.code)).join('\n')
    } finally {
      for (const build of builds) await build[Symbol.asyncDispose]()
    }
  }

  function importPath(from: string, to: string): string {
    return relative(dirname(from), to).replaceAll('\\', '/')
  }

  function checkCompilerModule(module: string, imports?: string[]): void {
    const plugins = config('dynamic').plugins as InputIsolationPlugin[]
    const plugin = plugins.find(plugin => plugin.name === 'dsh-client-input-isolation')
    if (plugin === undefined) throw new Error('client input isolation plugin missing')
    plugin.generateBundle.call({
      getModuleInfo: () => imports === undefined ? null : { importedIds: imports, dynamicallyImportedIds: [] },
    }, {}, {
      'client.js': { type: 'chunk', modules: { [module]: {} }, imports: [], dynamicImports: [] },
    })
  }

  it('accepts the exact compiler runtime helper without a source module record', () => {
    expect(() => { checkCompilerModule('\0rolldown/runtime.js') }).not.toThrow()
  })

  it.each(['\0rolldown/other.js', '\0rolldown/runtime.js?user', '\0other/runtime.js'])(
    'rejects the unrecorded module %j',
    (module) => {
      expect(() => { checkCompilerModule(module) }).toThrow(/has no bundler module record/)
    },
  )

  it('checks runtime helper dependencies when the compiler supplies a module record', () => {
    expect(() => { checkCompilerModule('\0rolldown/runtime.js', [experimental]) })
      .toThrow(/client bundle isolation.*experimental/)
  })

  it.each(['static', 'dynamic'] as const)('rejects experimental files folded into a %s client artifact', async (kind) => {
    const { owner, entry, prototype } = fixture()
    writeFileSync(entry, `export { marker } from ${JSON.stringify(importPath(entry, prototype))}\n`)

    await expect(bundle(owner, config(kind))).rejects.toThrow(/client bundle isolation.*experimental/)
    expect(existsSync(join(owner, 'lib/client.js'))).toBe(false)
    expect(existsSync(join(owner, 'lib/index.js'))).toBe(false)
  })

  it('proves the static library otherwise hides the experimental input in its emitted JavaScript', async () => {
    const { owner, entry, prototype } = fixture()
    writeFileSync(entry, `export { marker } from ${JSON.stringify(importPath(entry, prototype))}\n`)
    const guarded = config('static')
    const plugins = guarded.plugins as Array<{ name: string }>
    const unguarded: UserConfig = {
      ...guarded,
      plugins: plugins.filter(plugin => plugin.name !== 'dsh-client-input-isolation'),
      outputOptions: { sourcemapExcludeSources: false },
    }

    await expect(bundle(owner, unguarded)).resolves.toContain('experimental sentinel')
    await expect(bundle(owner, guarded)).rejects.toThrow(/client bundle isolation.*experimental/)
  })

  it.each(['static', 'dynamic'] as const)('allows an experimental %s artifact to keep its own inputs', async (kind) => {
    const { owner, entry, prototype } = fixture()
    writeFileSync(entry, `export { marker } from ${JSON.stringify(importPath(entry, prototype))}\n`)

    await expect(bundle(owner, config(kind, experimental))).resolves.toContain('experimental sentinel')
  })

  it('rejects experimental ownership preserved only by an emitted compiler source map', async () => {
    const { owner, entry, prototype } = fixture()
    writeFileSync(entry, 'export const marker = "experimental sentinel"\n//# sourceMappingURL=index.js.map\n')
    writeFileSync(`${entry}.map`, JSON.stringify({
      version: 3, names: [], mappings: 'AAAA', sources: [importPath(entry, prototype)],
      sourcesContent: ['export const marker = "experimental sentinel"\n'],
    }))

    await expect(bundle(owner, config('static'))).rejects.toThrow(/client bundle isolation.*experimental/)
  })

  it('checks the resolved module when an import alias conceals its experimental package', async () => {
    const { owner, entry, prototype } = fixture()
    writeFileSync(entry, 'export { marker } from "./ordinary.js"\n')

    await expect(bundle(owner, { ...config('static'), alias: { './ordinary.js': prototype } }))
      .rejects.toThrow(/client bundle isolation.*experimental/)
  })

  it('rejects an experimental runtime import left external by a static client library', async () => {
    const { owner, entry } = fixture()
    writeFileSync(entry, `export * from ${JSON.stringify(experimental)}\n`)

    await expect(bundle(owner, config('static'))).rejects.toThrow(/client bundle isolation.*experimental/)
  })

  it.each([false, true])('checks omitted source-map files against their package owner (experimental: %s)', async (experimentalSource) => {
    const { root, owner, entry } = fixture()
    const dependency = join(root, 'dependency')
    mkdirSync(dependency)
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: experimentalSource ? experimental : 'ordinary-library' }))
    writeFileSync(entry, 'export const marker = "mapped sentinel"\n//# sourceMappingURL=index.js.map\n')
    writeFileSync(`${entry}.map`, JSON.stringify({
      version: 3, names: [], mappings: 'AAAA', sourceRoot: importPath(entry, dependency),
      sources: ['unshipped.ts'], sourcesContent: ['export const marker = "mapped sentinel"\n'],
    }))

    const result = bundle(owner, config('static'))
    if (experimentalSource) await expect(result).rejects.toThrow(/client bundle isolation.*experimental/)
    else await expect(result).resolves.toContain('mapped sentinel')
  })

  it.each(['.css', '.module.css', '.css?inline'])('rejects experimental %s inputs behind client CSS virtual loaders', async (extension) => {
    const { owner, entry, prototype } = fixture()
    const css = join(dirname(prototype), `style${extension.replace('?inline', '')}`)
    writeFileSync(css, 'body { color: red; }\n')
    const specifier = `${importPath(entry, css)}${extension.endsWith('?inline') ? '?inline' : ''}`
    writeFileSync(entry, extension === '.css'
      ? `import ${JSON.stringify(specifier)}\nexport const marker = true\n`
      : `export { default as style } from ${JSON.stringify(specifier)}\n`)

    await expect(bundle(owner, config('dynamic'))).rejects.toThrow(/client bundle isolation.*experimental/)
  })

  it.each(['static', 'dynamic'] as const)('keeps ordinary %s bundles and source maps buildable', async (kind) => {
    const { owner, entry } = fixture()
    const source = join(owner, 'src/client/index.ts')
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, 'export const marker = "stable sentinel"\n')
    writeFileSync(entry, 'export const marker = "stable sentinel"\n//# sourceMappingURL=index.js.map\n')
    writeFileSync(`${entry}.map`, JSON.stringify({
      version: 3, names: [], mappings: 'AAAA', sources: [importPath(entry, source)],
      sourcesContent: ['export const marker = "stable sentinel"\n'],
    }))

    await expect(bundle(owner, config(kind))).resolves.toContain('stable sentinel')
  })
})

describe('client bundle module requests', () => {
  it('requests what the declaration lists', () => {
    const requests = requestedExternals('@deepseek-ai/dsh-client-fixture', {
      external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-slots'],
    })

    expect([...requests].sort()).toEqual([
      '@deepseek-ai/dsh-client-ui-slots', 'react', 'react/jsx-runtime',
    ])
  })

  it('requests nothing when the declaration is absent', () => {
    expect(requestedExternals('@deepseek-ai/dsh-client-fixture', {}).size).toBe(0)
  })

  it('rejects a malformed declaration instead of reading past it', () => {
    expect(() => requestedExternals('@deepseek-ai/dsh-client-fixture', { external: 'react' }))
      .toThrow(/dsh\.client\.external must be a string array/)
  })
})

describe('client bundle debug artifacts', () => {
  it('emits source maps for plugin TS and TSX outside the Vite module graph', () => {
    const configs = clientConfigs()
    expect(configs[0]?.sourcemap).toBe(true)
    expect(configs[0]?.outputOptions).toMatchObject({ sourcemapExcludeSources: false })
  })

  it('chains emitted tsc maps when the production Client build consumes lib/types', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-client-sourcemap-'))
    try {
      const entry = join(root, 'lib', 'types', 'client', 'index.js')
      const source = join(root, 'src', 'client', 'index.ts')
      const map = { version: 3, names: [], mappings: 'AAAA', sources: ['../../../src/client/index.ts'] }
      mkdirSync(join(root, 'lib', 'types', 'client'), { recursive: true })
      mkdirSync(join(root, 'src', 'client'), { recursive: true })
      writeFileSync(entry, 'export const marker = true\n//# sourceMappingURL=index.js.map\n')
      writeFileSync(`${entry}.map`, JSON.stringify(map))
      writeFileSync(source, 'export const marker: true = true\n')

      await expect(sourceMapPlugin().load!(entry)).resolves.toEqual({
        code: 'export const marker = true',
        map: { ...map, sourcesContent: ['export const marker: true = true\n'] },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('maps first-party sources to their repository package paths', () => {
    const configs = clientConfigs('@deepseek-ai/dsh-client-ui-goal')
    const outputOptions = configs[0]?.outputOptions
    if (typeof outputOptions !== 'object' || outputOptions === null) throw new Error('client output options missing')
    const transform = outputOptions.sourcemapPathTransform
    if (transform === undefined) throw new Error('client sourcemap path transform missing')

    const source = transform('../src/client/GoalBar.tsx', clientSourceMapPath('client/ui-goal'))
    expect(source).toBe('../../../packages/client/ui-goal/src/client/GoalBar.tsx')
    const resolved = new URL(source, 'https://dsh.test/plugins/@deepseek-ai/dsh-client-ui-goal/client.js.map')
    expect(resolved.pathname).toBe('/packages/client/ui-goal/src/client/GoalBar.tsx')
  })

  it('maps dual-face host sources to the host package group', () => {
    const configs = clientConfigs('@deepseek-ai/dsh-host-directory-picker-native')
    const outputOptions = configs[0]?.outputOptions
    if (typeof outputOptions !== 'object' || outputOptions === null) throw new Error('client output options missing')
    const transform = outputOptions.sourcemapPathTransform
    if (transform === undefined) throw new Error('client sourcemap path transform missing')

    const source = transform('../src/client/index.ts', clientSourceMapPath('host/directory-picker-native'))
    expect(source).toBe('../../../packages/host/directory-picker-native/src/client/index.ts')
  })

  it('maps inlined workspace sources to packages and leaves dependencies outside it unchanged', () => {
    const configs = clientConfigs('@deepseek-ai/dsh-client-connection')
    const outputOptions = configs[0]?.outputOptions
    if (typeof outputOptions !== 'object' || outputOptions === null) throw new Error('client output options missing')
    const transform = outputOptions.sourcemapPathTransform
    if (transform === undefined) throw new Error('client sourcemap path transform missing')

    const sourceMapPath = clientSourceMapPath('client/connection')
    const workspaceSource = transform('../src/rpc.ts', sourceMapPath)
    expect(workspaceSource).toBe('../../../packages/client/connection/src/rpc.ts')
    const resolved = new URL(workspaceSource, 'https://dsh.test/plugins/@deepseek-ai/dsh-client-connection/client.js.map')
    expect(resolved.pathname).toBe('/packages/client/connection/src/rpc.ts')

    const dependencySource = '../../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js'
    expect(transform(dependencySource, sourceMapPath)).toBe(dependencySource)
  })
})

describe('client bundle CSS Modules watch graph', () => {
  it('registers the physical stylesheet read behind a virtual module', async () => {
    const plugin = cssModulePlugin()
    const importer = fileURLToPath(new URL(
      '../packages/client/ui-conversation/src/client/queue/QueueDock.tsx',
      import.meta.url,
    ))
    const stylesheet = fileURLToPath(new URL(
      '../packages/client/ui-conversation/src/client/queue/QueueDock.module.css',
      import.meta.url,
    ))
    const virtualId = plugin.resolveId?.('./QueueDock.module.css', importer)
    if (virtualId === null || virtualId === undefined) throw new Error('CSS Modules import was not resolved')
    const addWatchFile = vi.fn()

    await plugin.load?.call({ addWatchFile }, virtualId)

    expect(addWatchFile).toHaveBeenCalledExactlyOnceWith(stylesheet)
  })
})
