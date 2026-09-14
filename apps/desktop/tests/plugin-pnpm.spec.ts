import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { c } from 'tar'
import { expect, it } from 'vitest'
import { DesktopProjectManager, type DesktopProjectHooks } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

it('installs a real pnpm graph, then executes approved scripts with the shared host instance', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-real-pnpm-')))
  const server = createServer()
  const archives = new Map<string, Buffer>()
  try {
    for (const name of ['fixture-plugin', 'node-pty']) {
      const path = writePackage(join(root, 'packages'), name, name === 'fixture-plugin'
        ? { dependencies: { 'node-pty': '1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.yml' } } }
        : { scripts: { install: 'node install.cjs' } }, 'export {identity} from "@deepseek-ai/cordis"')
      writeFileSync(join(path, 'bundle.yml'), '[]\n')
      writeFileSync(join(path, 'install.cjs'), 'require("node:fs").writeFileSync("built.json", JSON.stringify({node:process.execPath, host:require.resolve("@deepseek-ai/cordis")}))')
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
        ...(name === 'fixture-plugin' ? { dependencies: { 'node-pty': '1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' } } : {}),
      } }, time: { '1.0.0': '2020-01-01T00:00:00.000Z' } }))
    })
    const dsh = join(root, 'dsh')
    runtimeFixture(dsh)
    const pnpm = join(root, 'pnpm.mjs')
    const realPnpm = join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
    writeFileSync(pnpm, `process.argv = process.argv.map(arg => arg === '--config.registry=https://registry.npmjs.org/' ? ${JSON.stringify(`--config.registry=${origin}`)} : arg); await import(${JSON.stringify(pathToFileURL(realPnpm).href)})`)
    const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { node: process.execPath, pnpm, dsh })
    const hooks: DesktopProjectHooks = { beforeChange: async () => {}, afterChange: async () => {} }
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'fixture-plugin@1.0.0' }, hooks)
    expect(manager.listPlugins()).toEqual([{ name: 'fixture-plugin', version: '1.0.0', enabled: true }])
    const built = JSON.parse(readFileSync(join(manager.paths.profile, 'node_modules/node-pty/built.json'), 'utf8')) as { node: string; host: string }
    expect(realpathSync(built.node)).toBe(realpathSync(process.execPath))
    expect(built.host).toBe(join(dsh, 'node_modules/@deepseek-ai/cordis/index.js'))
    const entry = join(dsh, 'identity.mjs')
    writeFileSync(entry, `import {identity} from '@deepseek-ai/cordis'; import {identity as plugin} from ${JSON.stringify(pathToFileURL(join(manager.paths.profile, 'node_modules/fixture-plugin/index.js')).href)}; console.log(identity === plugin)`)
    expect(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim()).toBe('true')
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
