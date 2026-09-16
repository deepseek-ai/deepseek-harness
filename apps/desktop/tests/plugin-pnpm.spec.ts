import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { c } from 'tar'
import { expect, it } from 'vitest'
import { healIsolatedProfileModuleFallback, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { DesktopProjectManager, type DesktopProjectHooks } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

it('installs a real pnpm graph and executes scripts approved by user configuration', async () => {
  // pnpm resolves its cwd natively; use the same spelling for Windows 8.3 temp paths.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'desktop-real-pnpm-')))
  const server = createServer()
  const archives = new Map<string, Buffer>()
  try {
    for (const name of ['fixture-plugin', 'fixture-script-dependency']) {
      const path = writePackage(join(root, 'packages'), name, name === 'fixture-plugin'
        ? { dependencies: { 'fixture-script-dependency': '1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.yml' } } }
        : { scripts: { install: 'node install.cjs' } }, 'export {identity} from "@deepseek-ai/cordis"')
      writeFileSync(join(path, 'bundle.yml'), '[]\n')
      writeFileSync(join(path, 'install.cjs'), 'require("node:fs").writeFileSync("built.json", JSON.stringify({node:process.execPath}))')
      const tarball = join(root, `${name}.tgz`)
      await c({ file: tarball, cwd: join(path, '..'), gzip: true }, [name])
      archives.set(name, readFileSync(tarball))
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture registry has no TCP address')
    const origin = `http://127.0.0.1:${address.port}`
    server.on('request', (request, response) => {
      const name = request.url?.slice(1).replace(/\.tgz$/u, '') ?? ''
      const archive = archives.get(name)
      if (archive === undefined) { response.writeHead(404); response.end(); return }
      if (request.url?.endsWith('.tgz')) { response.end(archive); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {
        name, version: '1.0.0', dist: { tarball: `${origin}/${name}.tgz`, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` },
        ...(name === 'fixture-plugin' ? { dependencies: { 'fixture-script-dependency': '1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' } } : { scripts: { install: 'node install.cjs' } }),
      } }, time: { '1.0.0': '2020-01-01T00:00:00.000Z' } }))
    })
    const dsh = join(root, 'dsh')
    runtimeFixture(dsh)
    const pnpm = join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
    const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { node: process.execPath, pnpm, dsh })
    const installAnchor = join(dsh, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const hooks: DesktopProjectHooks = {
      beforeChange: async () => {},
      afterChange: async () => {
        const profile = loadProfileDirectory('desktop test', manager.paths.profile, installAnchor)
        healIsolatedProfileModuleFallback({ installAnchor, profile })
      },
    }
    await manager.applyRelease()
    writeFileSync(join(manager.paths.profile, '.npmrc'), `registry=${origin}\n`)
    writeFileSync(join(manager.paths.profile, 'pnpm-workspace.yaml'), `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ${JSON.stringify(join(root, 'store'))}\nallowBuilds:\n  fixture-script-dependency: true\n`)
    await manager.mutate({ type: 'plugin-add', spec: 'fixture-plugin@1.0.0' }, hooks)
    expect(manager.listPlugins()).toEqual([{ name: 'fixture-plugin', version: '1.0.0', enabled: true }])
    const builtPath = join(manager.paths.profile, 'node_modules/fixture-script-dependency/built.json')
    if (!existsSync(builtPath)) {
      const config = (name: string): string => execFileSync(process.execPath, [pnpm, 'config', 'get', name], {
        cwd: manager.paths.profile, encoding: 'utf8',
      }).trim()
      throw new Error(`pnpm install script produced no output: ignoreScripts=${config('ignoreScripts')}, allowBuilds=${config('allowBuilds')}`)
    }
    const built = JSON.parse(readFileSync(builtPath, 'utf8')) as { node: string }
    expect(realpathSync(built.node)).toBe(realpathSync(process.execPath))
    const entry = join(dsh, 'identity.mjs')
    writeFileSync(entry, `import {identity} from '@deepseek-ai/cordis'; import {identity as plugin} from ${JSON.stringify(pathToFileURL(join(manager.paths.profile, 'node_modules/fixture-plugin/index.js')).href)}; console.log(identity === plugin)`)
    expect(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim()).toBe('true')
    await manager.mutate({ type: 'plugin-update', name: 'fixture-plugin', version: '^1.0.0' }, hooks)
    expect(manager.listPlugins()[0]?.version).toBe('1.0.0')
    await manager.mutate({ type: 'plugin-remove', name: 'fixture-plugin' }, hooks)
    expect(manager.listPlugins()).toEqual([])
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve()
      })
    })
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

it.each(['directory', 'file', 'tarball', 'plain'] as const)('installs a %s source through pnpm', async (source) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'desktop-local-pnpm-')))
  try {
    const dsh = join(root, 'dsh')
    runtimeFixture(dsh)
    const packageDir = writePackage(join(root, 'local packages'), 'local-plugin', {
      ...(source === 'plain' ? {} : { dsh: { bundle: { patch: 'missing.yml' } } }),
      peerDependencies: { '@deepseek-ai/cordis': '^999.0.0' },
    })
    const tarball = join(root, 'local-plugin.tgz')
    await c({ file: tarball, cwd: join(packageDir, '..'), gzip: true }, ['local-plugin'])
    const spec = source === 'directory' ? packageDir : source === 'file' ? `file:${packageDir}` : tarball
    const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), {
      node: process.execPath, pnpm: join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs'), dsh,
    })
    const hooks: DesktopProjectHooks = { beforeChange: async () => {}, afterChange: async () => {} }
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec }, hooks)
    expect(manager.listPlugins()).toEqual([{ name: 'local-plugin', version: '1.0.0', enabled: source !== 'plain' }])
    expect(existsSync(join(manager.paths.profile, 'node_modules/local-plugin/missing.yml'))).toBe(false)
    await manager.disableAllPlugins()
    expect(manager.listPlugins()[0]?.enabled).toBe(false)
    await manager.mutate({ type: 'plugin-remove', name: 'local-plugin' }, hooks)
    expect(manager.listPlugins()).toEqual([])
    expect(existsSync(join(packageDir, 'package.json'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
