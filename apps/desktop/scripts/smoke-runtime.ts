/** Boot the materialized target runtime without access to a user's Harness profile. */

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readPrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

const OFFICE_SKILLS = ['office', 'office-docx', 'office-pptx', 'office-xlsx']

/**
 * Require each bundled Office skill to be listed and loaded with a nonempty body.
 * @param results - Host probe results; `bytes` is the loaded body length, 0 when unlisted or not loaded.
 * @throws Error listing every result when a bundled Office skill is missing or empty.
 */
export function assertOfficeSkillsLoadable(results: ReadonlyArray<{ readonly name: string; readonly bytes: number }>): void {
  if (!OFFICE_SKILLS.every(name => results.some(skill => skill.name === name && skill.bytes > 0))) {
    throw new Error(`desktop runtime: packaged Office skills are not loadable: ${JSON.stringify(results)}`)
  }
}

/**
 * Check CLI package operations, Host startup, its frontend, external plugins, packaged Office skill loading,
 * and real Office rendering, conversion, and recalculation.
 * @param root - Materialized dsh resources.
 * @param node - Prepared target Electron executable.
 * @param runtime - Verified resource descriptor.
 * @param environment - Credential-scrubbed build environment and private native cache.
 * @param resourcesRuntime - Bundled interpreters outside the application archive.
 * @returns Resolves after checks and teardown; rejects on a check or teardown failure.
 */
export async function smokeDesktopRuntime(
  root: string, node: string, runtime: DesktopRuntimeDescriptor, environment: NodeJS.ProcessEnv, resourcesRuntime: string,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  const profile = join(home, 'profiles', 'desktop')
  const hostEnvironment = {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(?:npm|pnpm|corepack)_/iu.test(name))),
    DSH_HOME: home, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
    APPDATA: home, LOCALAPPDATA: home,
    npm_config_userconfig: join(home, 'npmrc'), npm_config_globalconfig: join(home, 'npmrc'),
    npm_config_store_dir: join(home, 'store'), npm_config_enable_global_virtual_store: 'false',
  }
  const host = new DesktopHostProcess(node, root, profile, undefined, hostEnvironment,
    undefined, join(resourcesRuntime, 'primary-runtime'),
    { pnpm: join(resourcesRuntime, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), nodeBin: join(resourcesRuntime, 'bin') })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    writeFileSync(join(home, 'npmrc'), '')
    createPluginProfile(profile)
    const pluginName = 'desktop-runtime-smoke-plugin'
    const plugin = join(home, pluginName)
    mkdirSync(plugin, { recursive: true })
    const installedName = 'desktop-installed-smoke-plugin'
    const installedPlugin = join(home, installedName)
    mkdirSync(installedPlugin)
    writeFileSync(join(installedPlugin, 'package.json'), JSON.stringify({
      name: installedName, version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './bundle.yml' } },
    }))
    writeFileSync(join(installedPlugin, 'index.js'), `
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-installed',
    handler(_request, response) { response.end('installed plugin ready') } }))
}
`)
    writeFileSync(join(installedPlugin, 'bundle.yml'), `- insert:\n    - id: ${installedName}\n      name: ${installedName}\n      inject: [webServer]\n`)
    appendFileSync(join(profile, 'pnpm-workspace.yaml'), 'offline: true\nupdateNotifier: false\n')
    const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    const runCli = (args: string[]) => promisify(execFile)(node,
      ['--expose-internals', cli, 'plugin', '--profile', 'desktop', ...args],
      { cwd: home, env: { ...hostEnvironment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120_000, windowsHide: true })
    await runCli(['add', `file:${installedPlugin}`, '--offline', '--ignore-scripts'])
    const installedEntry = join(profile, 'node_modules', installedName, 'index.js')
    if (readFileSync(installedEntry, 'utf8') !== readFileSync(join(installedPlugin, 'index.js'), 'utf8')) {
      throw new Error('desktop runtime: CLI did not install the local plugin')
    }
    await runCli(['remove', installedName])
    if (existsSync(installedEntry)) throw new Error('desktop runtime: CLI did not remove the local plugin')
    console.log('desktop runtime: CLI offline plugin installation and removal passed')
    const primary = join(resourcesRuntime, 'primary-runtime')
    const dependencies = workspaceDependencyPaths(primary, await readPrimaryRuntime(primary))
    await promisify(execFile)(dependencies.python, ['-I', '-B',
      fileURLToPath(new URL('../tests/fixtures/office-conversion-inputs.py', import.meta.url)), home],
    { env: environment, timeout: 120_000, windowsHide: true })
    const inputs = ['docx', 'xlsx', 'pptx'].map(extension => ({ extension,
      bytes: readFileSync(join(home, `input.${extension}`)).toString('base64') }))
    const cordis = runtime.sharedPackages.find(entry => entry.name === '@deepseek-ai/cordis')
    if (cordis === undefined) throw new Error('desktop runtime: missing shared Cordis package')
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: pluginName, version: '1.0.0', type: 'module', exports: './index.js',
      peerDependencies: { '@deepseek-ai/cordis': cordis.version }, dsh: { bundle: { patch: './bundle.yml' } },
    }))
    writeFileSync(join(plugin, 'index.js'), `
import { Context } from '@deepseek-ai/cordis'
import { inspect } from 'node:util'
import { readFile } from 'node:fs/promises'
export function apply(ctx) {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke',
    handler(_request, response) { response.end('plugin route ready') } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-install',
    async handler(_request, response) {
      try {
        response.end(JSON.stringify(await ctx.pluginManager.installBundle(${JSON.stringify(installedPlugin)})))
      } catch (error) {
        response.statusCode = 500
        response.end(inspect(error, { depth: 5 }))
      }
    } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-skills',
    async handler(_request, response) {
      try {
        const names = ${JSON.stringify(OFFICE_SKILLS)}
        const listed = new Set((await ctx.skills.list()).map(skill => skill.name))
        const loaded = await Promise.all(names.map(async name => {
          const skill = listed.has(name) ? await ctx.skills.get(name) : undefined
          return { name, bytes: skill?.content.length ?? 0 }
        }))
        response.end(JSON.stringify(loaded))
      } catch (error) {
        response.statusCode = 500
        response.end(inspect(error, { depth: 5 }))
      }
    } }))
  for (const input of ${JSON.stringify(inputs)}) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-office/' + input.extension,
      async handler(_request, response) {
        try {
          const bytes = Buffer.from(input.bytes, 'base64')
          const result = await ctx.officeKit.convert({ extension: input.extension, priority: 'foreground',
            source: { key: 'desktop-smoke-' + input.extension, version: 'fixture', bytes: bytes.length,
              async read() { return { bytes, version: 'fixture' } } } })
          response.end(Buffer.from(result.pdf))
        } catch (error) {
          response.statusCode = 500
          response.end(inspect(error, { depth: 5 }))
        }
      } }))
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-office-operations/' + input.extension,
      async handler(_request, response) {
        try {
          const bytes = Buffer.from(input.bytes, 'base64')
          const source = (operation) => ({ key: 'desktop-smoke-' + operation + '-' + input.extension, version: 'fixture', bytes: bytes.length,
            async read() { return { bytes, version: 'fixture' } } })
          const rendered = await ctx.officeKit.renderImages({ extension: input.extension, source: source('images'),
            maxImages: 4, maxPixels: 16777216, maxDimension: 8192, maxBytes: 64 * 1024 * 1024 })
          const format = { docx: 'odt', xlsx: 'ods', pptx: 'odp' }[input.extension]
          const converted = await ctx.officeKit.convertTo({ extension: input.extension, format,
            source: source('convert'), output: { owner: 'desktop-smoke', name: 'converted.' + format } })
          const recalculated = input.extension === 'xlsx'
            ? await ctx.officeKit.recalculate({ extension: 'xlsx', format: 'xlsx', source: source('recalculate'),
              output: { owner: 'desktop-smoke', name: 'recalculated.xlsx' } })
            : undefined
          response.end(JSON.stringify({
            images: rendered.images.map(image => Buffer.from(image.png.subarray(0, 8)).toString('hex')),
            converted: (await readFile(converted.path)).subarray(0, 4).toString('hex'),
            recalculated: recalculated === undefined ? null : (await readFile(recalculated.path)).subarray(0, 4).toString('hex'),
          }))
        } catch (error) {
          response.statusCode = 500
          response.end(inspect(error, { depth: 5 }))
        }
      } }))
  }
}
`)
    writeFileSync(join(plugin, 'bundle.yml'), '- insert:\n    - id: desktop-runtime-smoke-plugin\n      name: desktop-runtime-smoke-plugin\n      inject: [webServer, officeKit, pluginManager, skills]\n')
    cpSync(plugin, join(profile, 'node_modules', pluginName), { recursive: true })
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies = { ...manifest.dependencies, [pluginName]: `file:${plugin}` }
    manifest.dsh.profile.bundles.push(pluginName)
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
    const ready = await Promise.race([host.start(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('desktop runtime: Host readiness exceeded 120 seconds')) }, 120_000)
    })])
    clearTimeout(timer)
    const login = await fetch(ready.url, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const response = await fetch(new URL('/', ready.url), { headers: { cookie } })
    if (response.status !== 200 || !(await response.text()).includes('<html')) {
      throw new Error('desktop runtime: packaged frontend smoke failed')
    }
    const pluginResponse = await fetch(new URL('/desktop-smoke', ready.url), { headers: { cookie } })
    if (await pluginResponse.text() !== 'plugin route ready') throw new Error('desktop runtime: plugin HTTP route failed')
    const installation = await fetch(new URL('/desktop-smoke-install', ready.url), {
      headers: { cookie }, signal: AbortSignal.timeout(120_000),
    })
    const installationResult = await installation.text()
    const installed = await fetch(new URL('/desktop-smoke-installed', ready.url), { headers: { cookie } })
    if (!installation.ok || !installed.ok || await installed.text() !== 'installed plugin ready') {
      throw new Error(`desktop runtime: bundled pnpm plugin installation failed: ${installationResult}`)
    }
    const skills = await fetch(new URL('/desktop-smoke-skills', ready.url), { headers: { cookie }, signal: AbortSignal.timeout(120_000) })
    if (!skills.ok) throw new Error(`desktop runtime: Office skill loading failed: ${await skills.text()}`)
    const loadedSkills = await skills.json() as { name: string; bytes: number }[]
    assertOfficeSkillsLoadable(loadedSkills)
    console.log('desktop runtime: packaged Office skills listed and loaded')
    for (const { extension } of inputs) {
      const converted = await fetch(new URL(`/desktop-smoke-office/${extension}`, ready.url), {
        headers: { cookie }, signal: AbortSignal.timeout(120_000),
      })
      if (!converted.ok) throw new Error(`desktop runtime: ${extension} conversion failed: ${await converted.text()}`)
      const pdf = Buffer.from(await converted.arrayBuffer())
      if (!/^%PDF-\d\.\d/u.test(pdf.subarray(0, 8).toString())
        || !pdf.subarray(-1024).toString().trimEnd().endsWith('%%EOF')) {
        throw new Error(`desktop runtime: invalid ${extension} PDF output`)
      }
    }
    for (const { extension } of inputs) {
      const operations = await fetch(new URL(`/desktop-smoke-office-operations/${extension}`, ready.url), {
        headers: { cookie }, signal: AbortSignal.timeout(240_000),
      })
      if (!operations.ok) throw new Error(`desktop runtime: ${extension} Office operations failed: ${await operations.text()}`)
      const result = await operations.json() as { images: string[]; converted: string; recalculated: string | null }
      // PNG images, then ZIP containers for OpenDocument and XLSX outputs.
      if (result.images.length === 0 || result.images.some(signature => signature !== '89504e470d0a1a0a')
        || result.converted !== '504b0304' || (extension === 'xlsx' ? result.recalculated !== '504b0304' : result.recalculated !== null)) {
        throw new Error(`desktop runtime: invalid ${extension} Office operation output: ${JSON.stringify(result)}`)
      }
    }
    console.log('desktop runtime: DOCX, XLSX, PPTX to PDF, image rendering, conversion, and recalculation passed')
  } finally {
    clearTimeout(timer)
    try { await host.stop() } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
    }
  }
}
