import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { installPrimaryRuntime, readPrimaryRuntime, workspaceDependencyPaths, type PrimaryRuntimeManifest } from '../src/primary-runtime.ts'
import * as workspaceDependencies from '../src/workspace-dependencies.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-primary-runtime-'))
  roots.push(directory)
  const source = join(directory, 'resources')
  const root = join(directory, 'home', 'dsh-runtimes', 'dsh-primary-runtime')
  const manifest: PrimaryRuntimeManifest = {
    desktopVersion: '1.0.0', platform: process.platform === 'win32' ? 'win32' : 'darwin', arch: process.arch,
    components: { python: '3.12.14', node: '24.21.0', pnpm: '11.7.0', numpy: '2.3.5', pandas: '3.0.1' },
  }
  const paths = workspaceDependencyPaths(source, manifest)
  for (const path of [paths.python, paths.node, paths.pnpm]) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'interpreter')
  }
  await mkdir(paths.pythonPackages, { recursive: true })
  await mkdir(paths.nodePackages, { recursive: true })
  await writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  return { source, root, manifest, directory }
}

it.each(['win32', 'darwin'])('returns %s interpreter and package paths', (platform) => {
  const manifest: PrimaryRuntimeManifest = { desktopVersion: '1', platform, arch: 'x64', components: { python: '3.12.14', node: '24.21.0', pnpm: '11.7.0', numpy: '2.3.5', pandas: '3.0.1' } }
  const paths = workspaceDependencyPaths('/runtime', manifest)
  expect(paths.python).toBe(join('/runtime', 'dependencies', 'python', ...(platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])))
  expect(paths.pythonPackages).toBe(join('/runtime', 'dependencies', 'python', ...(platform === 'win32' ? ['Lib'] : ['lib', 'python3.12']), 'site-packages'))
})

it.skipIf(process.platform === 'linux')('installs offline, reuses the same release, and leaves environment and user packages unchanged', async () => {
  const { source, root } = await fixture()
  const environment = { ...process.env }
  const installed = await installPrimaryRuntime(source, root)
  await writeFile(join(installed.pythonPackages, 'user-package.py'), 'user content')
  expect(await installPrimaryRuntime(source, root)).toEqual(installed)
  expect(await readFile(join(installed.pythonPackages, 'user-package.py'), 'utf8')).toBe('user content')
  expect(process.env).toEqual(environment)
})

it.skipIf(process.platform === 'linux')('replaces release components and recovers an interrupted directory swap', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await rename(root, `${root}.previous`)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2.0.0' }))
  await installPrimaryRuntime(source, root)
  expect((await readPrimaryRuntime(root)).desktopVersion).toBe('2.0.0')
})

it.skipIf(process.platform === 'linux')('keeps the installed release when the replacement payload is incomplete', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2.0.0' }))
  await rm(workspaceDependencyPaths(source, manifest).python)
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow()
  expect((await readPrimaryRuntime(root)).desktopVersion).toBe('1.0.0')
})

it.skipIf(process.platform === 'linux')('refuses linked installation directories without modifying their targets', async () => {
  const { source, root, directory } = await fixture()
  const outside = join(directory, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'untouched')
  await mkdir(dirname(root), { recursive: true })
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('filesystem link')
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('untouched')
})

it('rejects malformed metadata and incompatible targets', async () => {
  const { source, root, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, arch: process.arch === 'x64' ? 'arm64' : 'x64' }))
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('incompatible')
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, components: { ...manifest.components, python: '../escape' } }))
  await expect(readPrimaryRuntime(source)).rejects.toThrow('invalid metadata')
})

it.skipIf(process.platform === 'linux')('loads the real tool through Cordis, exposes installed paths, and unregisters on disposal', async () => {
  const { source, root, manifest, directory } = await fixture()
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime], ['dependencies', workspaceDependencies],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const config = join(directory, 'cordis.yml')
    await writeFile(config, `- name: agents\n- name: systemPrompt\n- name: tools\n- name: dependencies\n  config:\n    source: ${JSON.stringify(source)}\n    root: ${JSON.stringify(root)}\n`)
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const environment = { ...process.env }
    const request = { signal: new AbortController().signal, name: 'load_workspace_dependencies', arguments: {} }
    const results = await Promise.all(['first', 'second'].map(id => ctx.tools.execute({ ...request, callId: ToolCallId(id) })))
    for (const result of results) {
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(workspaceDependencyPaths(root, manifest), undefined, 2) }])
    }
    expect(process.env).toEqual(environment)
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dependencies')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name === 'load_workspace_dependencies')).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
})
