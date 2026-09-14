/** Resolve direct third-party browser inputs through the shipping build configurations, without emitting files. */

import { globSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Rolldown, type UserConfigExport } from 'tsdown'
import ts from 'typescript'
import { browserDependencyAnalysis } from '../apps/web/product-isolation.ts'

interface Manifest {
  name: string
  private?: boolean
  dsh?: { client?: unknown }
  exports?: Record<string, unknown>
}

interface ResolveContext {
  resolve(source: string, importer: string, options: { skipSelf: boolean }): Promise<{ id: string } | null>
}

/**
 * Name of the installed package owning a bundler-resolved file.
 * @param file - Resolved module or asset id, including any loader query.
 * @returns Package name, or undefined for workspace and virtual modules.
 */
export function browserPackageOfFile(file: string): string | undefined {
  const normalized = file.replaceAll('\\', '/')
  const marker = normalized.lastIndexOf('/node_modules/')
  if (marker < 0) return undefined
  const parts = normalized.slice(marker + '/node_modules/'.length).split('/')
  return parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function recorder(seen: Set<string>, workspaceNames: ReadonlySet<string>, followWorkspace = false) {
  return {
    name: 'dsh-browser-direct-dependencies',
    enforce: 'pre' as const,
    resolveId: {
      order: 'pre' as const,
      async handler(this: ResolveContext, source: string, importer: string | undefined) {
        if (importer === undefined || source.startsWith('.') || source.startsWith('/')
          || source.startsWith('\0') || source.startsWith('node:')) return null
        const parts = source.split('/')
        const name = source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
        if (name !== undefined && workspaceNames.has(name)) {
          return followWorkspace ? null : { id: source, external: true }
        }
        const resolved = await this.resolve(source, importer, { skipSelf: true })
        if (resolved === null) throw new Error(`browser notices: cannot resolve ${source} from ${importer}`)
        const owner = browserPackageOfFile(resolved.id)
        if (owner === undefined) return resolved
        if (browserPackageOfFile(importer) === undefined) seen.add(owner)
        // Notices disclose direct dependencies; upstream implementation imports stay in the lockfile.
        return { id: source, external: true }
      },
    },
  }
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}

/**
 * Source aliases shared with the repository's source-plane TypeScript programs.
 * @param root - Repository root containing tsconfig.base.json.
 * @returns Exact and wildcard aliases for the Vite dependency walk.
 */
export function browserSourceAliases(root: string): { find: RegExp; replacement: string }[] {
  const path = resolve(root, 'tsconfig.base.json')
  const config = ts.readConfigFile(path, file => ts.sys.readFile(file))
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  return Object.entries(parsed.options.paths ?? {}).map(([name, targets]) => {
    const target = targets[0]
    if (target === undefined) throw new Error(`browser notices: ${name} has no source target in ${path}`)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)')
    return { find: new RegExp(`^${escaped}$`), replacement: resolve(root, target).replace('*', '$1') }
  })
}

async function collectClientBundles(
  root: string,
  manifests: ReadonlyMap<string, Manifest>,
  workspaceNames: ReadonlySet<string>,
  seen: Set<string>,
): Promise<void> {
  for (const [manifestPath, manifest] of manifests) {
    if (manifest.private === true || manifest.dsh?.client === undefined) continue
    const dir = dirname(manifestPath)
    const loaded = await import(pathToFileURL(resolve(dir, 'tsdown.config.ts')).href) as { default: UserConfigExport }
    const factory = await loaded.default
    const configured = typeof factory === 'function' ? await factory({ env: {} }, { ci: false }) : factory
    const configs = Array.isArray(configured) ? configured : [configured]
    const client = configs.find(config => config.name === `${manifest.name}/client`)
    if (client === undefined) throw new Error(`browser notices: ${manifest.name} has no browser build config`)
    if (typeof client.inputOptions === 'function') throw new Error(`browser notices: ${manifest.name} needs resolved input options`)
    const bundle = await Rolldown.rolldown({
      ...client.inputOptions,
      cwd: dir,
      input: client.entry as Rolldown.InputOption,
      platform: 'browser',
      transform: client.define === undefined ? {} : { define: client.define },
      plugins: [recorder(seen, workspaceNames), client.plugins ?? []] as NonNullable<Rolldown.InputOptions['plugins']>,
      tsconfig: resolve(root, 'tsconfig.base.client.json'),
    })
    try {
      await bundle.generate({ format: 'cjs', sourcemap: false })
    } finally {
      await bundle.close()
    }
  }
}

interface ShellConfig {
  build: { rollupOptions?: { input?: string | string[] | Record<string, string> } }
}

interface ViteApi {
  resolveConfig(
    config: Record<string, unknown>, command: 'build', defaultMode: string, defaultNodeEnv: string,
  ): Promise<ShellConfig>
  build(config: Record<string, unknown>): Promise<unknown>
}

async function collectShell(
  root: string,
  workspaceNames: ReadonlySet<string>,
  seen: Set<string>,
): Promise<void> {
  for (const path of globSync('apps/*/vite.config.ts', { cwd: root }).sort()) {
    const dir = dirname(resolve(root, path))
    const manifest = readManifest(resolve(dir, 'package.json'))
    if (manifest.private === true || manifest.exports?.['./dist/*'] === undefined) continue
    const vitePath = createRequire(resolve(dir, 'package.json')).resolve('vite')
    const vite = await import(pathToFileURL(vitePath).href) as ViteApi
    const config = await vite.resolveConfig({ root: dir, logLevel: 'error' }, 'build', 'production', 'production')
    const input = config.build.rollupOptions?.input
    const entries = typeof input === 'string' ? [input] : Object.values(input ?? {})
    const pages = entries.filter(entry => entry.endsWith('.html'))
    if (pages.length === 0) throw new Error(`browser notices: ${manifest.name} has no HTML build entry`)
    await vite.build({
      root: dir,
      logLevel: 'error',
      plugins: [browserDependencyAnalysis(), recorder(seen, workspaceNames, true)],
      resolve: { alias: browserSourceAliases(root) },
      build: {
        write: false,
        minify: false,
        sourcemap: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: pages.length === 1 ? pages[0] : pages,
          // Chunk coloring expects full third-party bodies; the disclosure walk stops at their imports.
          output: { manualChunks: () => undefined },
        },
      },
    })
  }
}

/**
 * Direct third-party packages resolved by published browser builds.
 * @param root - Repository root, possibly symlinked, with installed build dependencies; lib/ is not required.
 * @returns Names of distributed browser inputs, excluding workspace packages and erased types.
 */
export async function browserBundledExternals(root: string): Promise<Set<string>> {
  // Vite resolves HTML through native realpath, including Windows 8.3 alias expansion.
  root = realpathSync.native(root)
  const manifests = new Map<string, Manifest>()
  for (const glob of ['packages/*/*/package.json', 'vendor/*/package.json']) {
    for (const path of globSync(glob, { cwd: root }).sort()) {
      const absolute = resolve(root, path)
      manifests.set(absolute, readManifest(absolute))
    }
  }
  const names = new Set([...manifests.values()].map(manifest => manifest.name))
  const seen = new Set<string>()
  await collectClientBundles(root, manifests, names, seen)
  await collectShell(root, names, seen)
  return seen
}
