/** Real CLI profile imports in source and built launches, including npm-link dependency layouts. */

import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveExampleLaunch, type ExampleMode } from '@deepseek-ai/dsh-loader-smoke'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const processTimeoutMs = 75_000
const bundleName = 'profile-resolution-bundle'
const bridgeName = 'profile-resolution-bridge'
const leafName = 'profile-resolution-leaf'
const pluginName = 'profile-resolution-plugin'
const sourceProbeName = 'source-probe'
const externalName = 'profile-resolution-external'
const externalLeafName = 'profile-resolution-external-leaf'
const marker = 'DSH_PROFILE_RESOLUTION '

interface ResolutionEvidence {
  execArgv: string[]
  esm: { version: string; url: string }
  cjs: { version: string; filename: string }
  sameEsmLeaf: boolean
  sameCjsLeaf: boolean
  externalEsm: { version: string; url: string; leaf: ResolutionEvidence['esm'] }
  externalCjs: { version: string; filename: string; leaf: ResolutionEvidence['cjs'] }
  sameEsmExternal: boolean
  sameCjsExternal: boolean
  sameEsmExternalLeaf: boolean
  sameCjsExternalLeaf: boolean
  externalManaged: boolean
  toolsInstance: boolean
  pluginToolsInstance: boolean
  sourceToolsInstance: boolean
  profileToolsCjs: string | null
  sourceToolsCjs: string | null
  sourceLeafCjs: string
  sourceLeafExplicitCjs: string
  scheduler: boolean
  modules: string[]
}

async function writePackage(dir: string, manifest: Record<string, unknown>, files: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest) + '\n')
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content + '\n')
}

/**
 * Register the same runtime-resolution assertions in the source-only and built-bin lanes.
 * @param mode - source uses the CLI's ESM-only tsx hook; lib requires built workspace exports.
 */
export function testProfileResolution(mode: ExampleMode): void {
  it.each(['installed', 'npm-link'] as const)(`resolves a %s profile dependency graph in ${mode} mode`, {
    timeout: processTimeoutMs + 15_000, retry: 0,
  }, async (layout) => {
    // The child reports loaded module paths in the form DSH_HOME was given; hand it the native realpath so
    // Windows 8.3 tmpdir names and macOS /var symlinks match the expectations computed below.
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'dsh-profile-resolution-')))
    const links: string[] = []
    try {
      const home = join(root, 'home')
      const profileDir = join(home, 'profiles', 'headless')
      const installedBundle = join(profileDir, 'node_modules', bundleName)
      const bundleDir = layout === 'npm-link' ? join(root, 'work', bundleName) : installedBundle
      const installedBridge = join(bundleDir, 'node_modules', bridgeName)
      const bridgeDir = layout === 'npm-link' ? join(root, 'dependencies', bridgeName) : installedBridge
      const logicalLeaf = join(bundleDir, 'node_modules', leafName)
      const realLeaf = join(root, 'dependencies', 'node_modules', leafName)
      const sourcePackageDir = join(root, 'work', 'source-package')
      const sourceDevLeaf = join(sourcePackageDir, 'node_modules', leafName)
      const exports = { import: './index.mjs', require: './index.cjs' }
      await writePackage(bundleDir, {
        name: bundleName, version: '1.0.0', dependencies: { [bridgeName]: '*' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, { 'cordis.patch.yml': '[]' })
      await writePackage(bridgeDir, {
        name: bridgeName, version: '1.0.0', exports, dependencies: { [leafName]: '*' },
      }, {
        'index.mjs': `export { leaf } from '${leafName}'`,
        'index.cjs': `module.exports = require('${leafName}')`,
      })
      for (const [dir, version] of [
        [logicalLeaf, '1.0.0'], [realLeaf, '2.0.0'], [sourceDevLeaf, '0.0.0'],
      ] as const) {
        await writePackage(dir, { name: leafName, version, exports }, {
          'index.mjs': `export const leaf = { version: '${version}', url: import.meta.url }`,
          'index.cjs': `exports.leaf = { version: '${version}', filename: __filename }`,
        })
      }
      if (layout === 'npm-link') {
        const globalBundle = join(root, 'npm-global', 'node_modules', bundleName)
        for (const [target, link] of [[bundleDir, globalBundle], [globalBundle, installedBundle], [bridgeDir, installedBridge]] as const) {
          await mkdir(dirname(link), { recursive: true })
          await symlink(target, link, 'junction')
          links.push(link)
        }
      }

      const sharedModules = join(home, 'profiles', 'node_modules')
      const installedPlugin = join(profileDir, 'node_modules', pluginName)
      // npm-link keeps the plugin as a linked root outside the profile tree, so its own node_modules hold the
      // developer's devDependency dsh-tools copy (stale, never read) and the declared dependency's install.
      const pluginDir = layout === 'npm-link' ? join(root, 'work', pluginName) : installedPlugin
      const sharedExternal = join(sharedModules, externalName)
      const externalDir = layout === 'npm-link' ? join(root, 'external', externalName) : sharedExternal
      const externalLeaf = join(externalDir, 'node_modules', externalLeafName)
      const sharedLeaf = join(sharedModules, externalLeafName)
      const ancestorExternal = join(home, 'node_modules', externalName)
      const ancestorLeaf = join(home, 'node_modules', externalLeafName)
      await writePackage(pluginDir, {
        name: pluginName, version: '1.0.0', exports, dependencies: { [externalName]: '*' },
        peerDependencies: { '@deepseek-ai/dsh-tools': '*' }, devDependencies: { '@deepseek-ai/dsh-tools': '*' },
      }, {
        'index.mjs': [
          `export { external } from '${externalName}'`,
          "import Tools from '@deepseek-ai/dsh-tools'",
          'export { Tools as PluginTools }',
          'export function apply() {}',
        ].join('\n'),
        'index.cjs': `module.exports = require('${externalName}')`,
      })
      for (const [dir, version] of [[externalDir, '3.0.0'], [ancestorExternal, '9.0.0']] as const) {
        await writePackage(dir, { name: externalName, version, exports, dependencies: { [externalLeafName]: '*' } }, {
          'index.mjs': `import { leaf } from '${externalLeafName}'\nexport const external = { version: '${version}', url: import.meta.url, leaf }`,
          'index.cjs': `exports.external = { version: '${version}', filename: __filename, leaf: require('${externalLeafName}').leaf }`,
        })
      }
      for (const [dir, version] of [[externalLeaf, '4.0.0'], [sharedLeaf, '8.0.0'], [ancestorLeaf, '9.0.0']] as const) {
        await writePackage(dir, { name: externalLeafName, version, exports }, {
          'index.mjs': `export const leaf = { version: '${version}', url: import.meta.url }`,
          'index.cjs': `exports.leaf = { version: '${version}', filename: __filename }`,
        })
      }
      const staleTools = join(root, 'stale-tools')
      const staleToolsLink = join(sharedModules, '@deepseek-ai', 'dsh-tools')
      await writePackage(staleTools, { name: '@deepseek-ai/dsh-tools', version: '0.0.0', exports }, {
        'index.mjs': "export default class Tools {}\nexport const TOOL_RUNTIME_SCHEDULER = Symbol()\nthrow new Error('STALE_DSH_TOOLS')",
        'index.cjs': "throw new Error('STALE_DSH_TOOLS')",
      })
      const sourceDir = join(sourcePackageDir, 'src')
      const toolsCjsExpression = mode === 'lib' ? "require.resolve('@deepseek-ai/dsh-tools')" : 'null'
      await mkdir(sourceDir, { recursive: true })
      // The ESM-only source hook does not map CommonJS exports to source, so its CJS probe uses a fixture-owned peer.
      await writePackage(sourcePackageDir, {
        name: 'source-package', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '*', [leafName]: '*' },
      }, {
        'src/query.mjs': [
          "import { createRequire } from 'node:module'",
          "import Tools from '@deepseek-ai/dsh-tools'",
          'export { Tools as SourceTools }',
          'const require = createRequire(import.meta.url)',
          `export const sourceToolsCjs = ${toolsCjsExpression}`,
          `export const sourceLeafCjs = require.resolve('${leafName}')`,
          `export const sourceLeafExplicitCjs = require.resolve('${leafName}', { paths: [${JSON.stringify(sourceDir)}] })`,
        ].join('\n'),
      })
      for (const [target, link] of [
        [staleTools, staleToolsLink],
        [sourceDir, join(profileDir, 'node_modules', sourceProbeName)],
        [staleTools, join(sourcePackageDir, 'node_modules', '@deepseek-ai', 'dsh-tools')],
        ...layout === 'npm-link' ? [
          [externalDir, sharedExternal],
          [pluginDir, installedPlugin],
          [staleTools, join(pluginDir, 'node_modules', '@deepseek-ai', 'dsh-tools')],
          [externalDir, join(pluginDir, 'node_modules', externalName)],
        ] as const : [],
      ] as const) {
        await mkdir(dirname(link), { recursive: true })
        await symlink(target, link, 'junction')
        links.push(link)
      }

      // The probe imports from the profile, where the bundle's transitive dependencies need fallback.
      await writePackage(profileDir, {
        name: 'resolution-profile', private: true, dependencies: { [bundleName]: '*', [pluginName]: '*' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', bundleName] } },
      }, {
        'probe.mjs': [
          "import { createRequire } from 'node:module'",
          "import { getEnvironmentData } from 'node:worker_threads'",
          "import Tools, { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'",
          `import { leaf } from '${leafName}'`,
          `import { leaf as bridgeLeaf } from '${bridgeName}'`,
          `import { external } from '${externalName}'`,
          `import { external as pluginExternal, PluginTools } from '${pluginName}'`,
          `import { SourceTools, sourceToolsCjs, sourceLeafCjs, sourceLeafExplicitCjs } from '${sourceProbeName}/query.mjs'`,
          `import { leaf as externalLeaf } from ${JSON.stringify(pathToFileURL(join(externalLeaf, 'index.mjs')).href)}`,
          'const require = createRequire(import.meta.url)',
          "export const inject = ['tools', 'agentLoop', 'loader']",
          'export function apply(ctx) {',
          "  const ready = ctx.get('appReady')",
          "  const exit = ctx.get('appExit')",
          '  ctx.effect(() => ready.onReady(() => {',
          `    const cjs = require('${leafName}').leaf`,
          `    const externalCjs = require('${externalName}').external`,
          "    const entries = getEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution').resolution.entries",
          '    const evidence = {',
          '      execArgv: process.execArgv, esm: leaf, cjs,',
          '      sameEsmLeaf: leaf === bridgeLeaf,',
          `      sameCjsLeaf: cjs === require('${bridgeName}').leaf,`,
          '      externalEsm: external, externalCjs,',
          '      sameEsmExternal: external === pluginExternal,',
          `      sameCjsExternal: externalCjs === require('${pluginName}').external,`,
          '      sameEsmExternalLeaf: external.leaf === externalLeaf,',
          `      sameCjsExternalLeaf: externalCjs.leaf === require(${JSON.stringify(join(externalLeaf, 'index.cjs'))}).leaf,`,
          `      externalManaged: entries.some(entry => [${JSON.stringify(externalName)}, ${JSON.stringify(externalLeafName)}].includes(entry.name)),`,
          '      toolsInstance: ctx.tools instanceof Tools,',
          '      pluginToolsInstance: ctx.tools instanceof PluginTools,',
          '      sourceToolsInstance: ctx.tools instanceof SourceTools,',
          `      profileToolsCjs: ${toolsCjsExpression},`,
          '      sourceToolsCjs, sourceLeafCjs, sourceLeafExplicitCjs,',
          "      scheduler: typeof ctx.tools[TOOL_RUNTIME_SCHEDULER]?.prepare === 'function',",
          '      modules: [...ctx.loader.internal.loadCache.keys()]',
          '        .filter(url => /\\/packages\\/core\\/(?:tools|agent-loop)\\//.test(url)),',
          '    }',
          `    process.stdout.write('${marker}' + JSON.stringify(evidence) + '\\n')`,
          '    exit(0)',
          "  }), 'profile resolution probe')",
          '}',
        ].join('\n'),
        'cordis.patch.yml': JSON.stringify([
          { id: 'headless-startup', disabled: true },
          { id: 'headless-runner', disabled: true },
          { id: 'llm-deepseek', disabled: true },
          { insert: [
            { id: 'external-plugin', name: pluginName },
            { id: 'resolution-probe', name: join(profileDir, 'probe.mjs') },
          ] },
        ]),
      })
      const packageDirs = [
        bundleDir, bridgeDir, logicalLeaf, realLeaf, sourceDevLeaf, pluginDir, externalDir, externalLeaf,
        sharedLeaf, ancestorExternal, ancestorLeaf, staleTools, sourcePackageDir, sourceDir, profileDir,
      ]
      const packageFiles = (await Promise.all(packageDirs.map(async dir =>
        (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(dir, entry.name)),
      ))).flat()
      const contents = await Promise.all(packageFiles.map(async path => [path, await readFile(path)] as const))
      const linkTargets = await Promise.all(links.map(async path => [path, await readlink(path)] as const))
      const launch = resolveExampleLaunch({
        srcBin: join(repoRoot, 'apps/cli/src/bin.ts'),
        mode, sourceImport: 'tsx/esm', tsconfigPath: join(repoRoot, 'tsconfig.json'),
        configArgs: ['--profile', 'headless'],
        env: {
          DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
          NODE_OPTIONS: undefined, TSX_TSCONFIG_PATH: undefined,
        },
      })
      const result = await execa(launch.command, launch.args, {
        cwd: repoRoot, env: launch.env, input: '', timeout: processTimeoutMs,
        killSignal: 'SIGKILL', reject: false,
      })
      const diagnostic = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      expect(result.timedOut, diagnostic).toBe(false)
      expect(result.signal, diagnostic).toBeUndefined()
      expect(result.exitCode, diagnostic).toBe(0)
      const records = result.stdout.split('\n').filter(line => line.startsWith(marker))
      expect(records, diagnostic).toHaveLength(1)
      const evidence = JSON.parse(records[0]!.slice(marker.length)) as ResolutionEvidence
      const selectedLeaf = layout === 'npm-link' ? realLeaf : logicalLeaf
      const version = layout === 'npm-link' ? '2.0.0' : '1.0.0'
      expect(evidence.esm).toEqual({ version, url: pathToFileURL(realpathSync.native(join(selectedLeaf, 'index.mjs'))).href })
      expect(evidence.cjs).toEqual({ version, filename: realpathSync.native(join(selectedLeaf, 'index.cjs')) })
      expect(evidence.sameEsmLeaf).toBe(true)
      expect(evidence.sameCjsLeaf).toBe(true)
      expect(evidence.externalEsm).toEqual({
        version: '3.0.0', url: pathToFileURL(realpathSync.native(join(externalDir, 'index.mjs'))).href,
        leaf: { version: '4.0.0', url: pathToFileURL(realpathSync.native(join(externalLeaf, 'index.mjs'))).href },
      })
      expect(evidence.externalCjs).toEqual({
        version: '3.0.0', filename: realpathSync.native(join(externalDir, 'index.cjs')),
        leaf: { version: '4.0.0', filename: realpathSync.native(join(externalLeaf, 'index.cjs')) },
      })
      expect(evidence.sameEsmExternal).toBe(true)
      expect(evidence.sameCjsExternal).toBe(true)
      expect(evidence.sameEsmExternalLeaf).toBe(true)
      expect(evidence.sameCjsExternalLeaf).toBe(true)
      expect(evidence.externalManaged).toBe(false)
      expect(evidence.toolsInstance).toBe(true)
      expect(evidence.pluginToolsInstance).toBe(true)
      expect(evidence.sourceToolsInstance).toBe(true)
      expect(evidence.sourceToolsCjs).toBe(evidence.profileToolsCjs)
      expect(evidence.profileToolsCjs).toBe(mode === 'lib'
        ? realpathSync.native(join(repoRoot, 'packages/core/tools/lib/index.js'))
        : null)
      expect(evidence.sourceLeafCjs).toBe(evidence.cjs.filename)
      expect(evidence.sourceLeafExplicitCjs).toBe(realpathSync.native(join(sourceDevLeaf, 'index.cjs')))
      expect(evidence.sourceLeafCjs).not.toBe(evidence.sourceLeafExplicitCjs)
      expect(evidence.scheduler).toBe(true)
      expect(evidence.execArgv).toEqual(mode === 'src' ? launch.args.slice(0, 2) : [])
      for (const name of ['tools', 'agent-loop']) {
        const selected = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
        const other = mode === 'src' ? 'lib' : 'src'
        expect(evidence.modules.filter(url => url.endsWith(`/packages/core/${name}/${selected}`))).toHaveLength(1)
        expect(evidence.modules.filter(url => url.includes(`/packages/core/${name}/${other}/`))).toEqual([])
      }
      for (const [path, content] of contents) expect(await readFile(path), path).toEqual(content)
      for (const [path, target] of linkTargets) expect(await readlink(path), path).toBe(target)
      expect(await readdir(sourceDir)).toEqual(['query.mjs'])
    } finally {
      try {
        for (const link of links.reverse()) await unlink(link)
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })
}
