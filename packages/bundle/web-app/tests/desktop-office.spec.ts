/** Web application Office rows over a real Loader tree: carrier paths, profile gating, Python environments, and failure containment. */

import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { resolveKitCli } from '@deepseek-ai/dsh-office-kit/locate'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WorkspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

// Only the consumer module location differs from a deployed runtime; keep resolution and containment real.
vi.mock('@deepseek-ai/dsh-office-kit/locate', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-office-kit/locate')>()
  return { ...actual, resolveKitCli: vi.fn(actual.resolveKitCli) }
})

const assets = fileURLToPath(new URL('../../../skill/skill-office/assets/', import.meta.url))
const names = ['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx']

afterEach(() => { vi.unstubAllEnvs(); vi.mocked(resolveKitCli).mockReset() })

async function boot(profile: string, primaryRuntime: (root: string) => string | undefined,
  officeCli: (root: string) => string | undefined = root => join(root, 'office-cli.js'),
  launcher: (root: string) => { skills?: string; node?: string } = () => ({}),
  layout: 'plain' | 'asar' | 'missing' | 'development' = 'plain',
  runtimeRoot: (runtime: string) => string | undefined = runtime => runtime) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-desktop-office-rows-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  vi.stubEnv('DSH_BUNDLED_PRIMARY_RUNTIME', primaryRuntime(root))
  vi.stubEnv('DSH_BUNDLED_OFFICE_CLI', officeCli(root))
  const { skills, node } = launcher(root)
  vi.stubEnv('DSH_BUNDLED_OFFICE_SKILLS', skills)
  vi.stubEnv('DSH_BUNDLED_OFFICE_NODE', node)
  await cp(assets, join(root, 'office-skills'), { recursive: true })
  const runtime = join(root, layout === 'asar' ? 'app.asar/dsh' : 'dsh')
  await mkdir(runtime, { recursive: true })
  vi.stubEnv('DSH_BUNDLED_RUNTIME_ROOT', runtimeRoot(runtime))
  const physical = join(root, layout === 'asar' ? 'app.asar.unpacked/dsh' : layout === 'development' ? 'node_modules/.pnpm/kit' : 'dsh')
  const cli = join(physical, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
  if (layout !== 'missing') {
    for (const directory of new Set(layout === 'development' ? [physical] : [runtime, physical])) {
      const kit = join(directory, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
      await mkdir(join(kit, 'lib'), { recursive: true })
      await writeFile(join(kit, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit',
        exports: { '.': './lib/index.js', './cli': './lib/cli.js' } }))
      await writeFile(join(kit, 'lib', 'index.js'), '')
      await writeFile(join(kit, 'lib', 'cli.js'), '')
    }
  }
  if (layout === 'development') {
    const scope = join(runtime, 'node_modules', '@deepseek-ai')
    await mkdir(scope, { recursive: true })
    await symlink(join(physical, 'node_modules', '@deepseek-ai', 'libreoffice-kit'), join(scope, 'libreoffice-kit'), 'junction')
  }
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-office-kit/locate')>('@deepseek-ai/dsh-office-kit/locate')
  vi.mocked(resolveKitCli).mockImplementation(options => actual.resolveKitCli({
    ...options,
    lookupKitEntry: () => pathToFileURL(createRequire(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'package.json'))
      .resolve('@deepseek-ai/libreoffice-kit')),
  }))
  const nodePath = join(root, 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  await mkdir(dirname(nodePath), { recursive: true })
  await writeFile(nodePath, '')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', {
    name: profile, dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  ctx.provide('dshHomePath', dshHomePath)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.dependencies = WorkspaceDependencies
  ctx.loader.builtins.office = SkillOffice
  const rows = loadOverlayPatches('desktop-office', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'workspace-dependencies' || row.id === 'skill-office')
  expect(rows.map(row => row.id)).toEqual(['workspace-dependencies', 'skill-office'])
  await ctx.loader.root.update(rows.map(row => ({ ...row, name: row.id === 'skill-office' ? 'cordis:office' : 'cordis:dependencies' })))
  await ctx.loader.await()
  return { ctx, root, runtime, cli }
}

it.each(['plain', 'asar'] as const)('resolves Desktop Office CLI paths inside a %s runtime', async (layout) => {
  const { ctx, root, runtime, cli } = await boot('desktop', root => join(root, 'primary-runtime'), undefined, undefined, layout)
  // Desktop omits pythonEnvironment; the skill-office default selects the bundled environment.
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toEqual({
    assetRoot: join(root, 'office-skills'),
    node: join(root, 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    kitRoot: runtime,
    cli: undefined,
    pythonEnvironment: 'workspace-dependencies',
  })
  expect((await ctx.skills.get('office-render'))?.content).toContain(JSON.stringify(cli))
  expect(ctx.loader.resolve('workspace-dependencies').fiber?.effectiveConfig).toEqual({
    source: join(root, 'primary-runtime'), root: join(root, 'home', 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['load_workspace_dependencies'])
  expect((await ctx.skills.get('office-docx'))?.content).toMatch(/## Python environment\n\n.*`load_workspace_dependencies`/u)
})

it.each(['plain', 'development'] as const)('leaves Desktop Kit discovery unrestricted without a runtime root (%s)', async (layout) => {
  const { ctx, runtime, cli } = await boot('desktop', root => join(root, 'primary-runtime'), undefined, undefined, layout, () => undefined)
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toHaveProperty('kitRoot', undefined)
  if (layout === 'development') {
    expect(await realpath(join(runtime, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'))).toBe(cli)
    expect(cli.startsWith(`${runtime}${sep}`)).toBe(false)
  }
  expect((await ctx.skills.get('office-render'))?.content).toContain(JSON.stringify(cli))
  expect(resolveKitCli).toHaveLastReturnedWith(expect.objectContaining({ kind: 'available', cli }))
})

it('keeps Office skills and warns once when no Kit is available inside the Desktop runtime', async () => {
  const { ctx, root } = await boot('desktop', root => join(root, 'primary-runtime'), root => join(root, 'stale-cli.js'), undefined, 'missing')
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toMatchObject({ assetRoot: join(root, 'office-skills'), kitRoot: join(root, 'dsh'), cli: undefined, pythonEnvironment: 'workspace-dependencies' })
  expect(ctx.loader.resolve('workspace-dependencies').fiber?.effectiveConfig).toEqual({
    source: join(root, 'primary-runtime'), root: join(root, 'home', 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  const warnings: string[] = []
  ctx.logger.exporter({ levels: { default: 2 }, export: ({ type, args }) => { if (type === 'warn') warnings.push(String(args[0])) } })
  for (const name of ['office-render', 'office-recalculate', 'office-export-pdf']) {
    const content = (await ctx.skills.get(name))?.content
    expect(content).toMatch(/\n\nLibreOffice Kit is not available in this deployment\.$/u)
    expect(content).not.toContain('libreofficeKit')
  }
  expect(warnings).toHaveLength(1)
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['load_workspace_dependencies'])
})

it('mounts Office skills with packaged defaults and the user Python outside the Desktop profile without launcher variables', async () => {
  const { ctx } = await boot('web', () => undefined, () => undefined)
  expect(ctx.loader.resolve('skill-office').disabled).toBe(false)
  // Each path expression evaluates to `undefined`; the schema leaves it unset so skill-office applies its packaged default.
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({
    kitRoot: undefined, assetRoot: undefined, node: undefined, cli: undefined, pythonEnvironment: 'user',
  })
  expect(ctx.loader.resolve('workspace-dependencies').disabled).toBe(true)
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect((await ctx.skills.get('office-docx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-docx').split(sep).join('/') })
  const docx = (await ctx.skills.get('office-docx'))?.content
  expect(docx).toMatch(/## Python environment\n\n.*`python3` or `python` on PATH/u)
  expect(docx).not.toContain('load_workspace_dependencies')
  expect((await ctx.skills.get('office-render'))?.content).toContain(JSON.stringify(process.execPath))
  expect(ctx.tools.schemas()).toEqual([])
})

it('disables the Kit CLI outside the Desktop profile when the launcher sets an empty CLI', async () => {
  const { ctx } = await boot('web', () => undefined, () => '')
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({
    kitRoot: undefined, assetRoot: undefined, node: undefined, cli: false, pythonEnvironment: 'user',
  })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  for (const name of ['office-render', 'office-recalculate', 'office-export-pdf']) {
    const content = (await ctx.skills.get(name))?.content
    expect(content).toMatch(/\n\nLibreOffice Kit is disabled in this deployment\.$/u)
    expect(content).not.toContain('libreofficeKit')
  }
})

it('uses the launcher Node and Kit CLI outside the Desktop profile', async () => {
  const { ctx, root } = await boot('web', () => undefined, root => join(root, 'sidecar-cli.js'), root => ({ node: join(root, 'sidecar-node') }))
  for (const file of ['sidecar-cli.js', 'sidecar-node']) await writeFile(join(root, file), '')
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({
    kitRoot: undefined, assetRoot: undefined, node: join(root, 'sidecar-node'), cli: join(root, 'sidecar-cli.js'), pythonEnvironment: 'user',
  })
  expect((await ctx.skills.get('office-render'))?.content)
    .toContain(JSON.stringify({ libreofficeKit: { node: join(root, 'sidecar-node'), cli: join(root, 'sidecar-cli.js') } }, undefined, 2))
})

it('reads Office skills from the launcher skill directory outside the Desktop profile', async () => {
  const { ctx, root } = await boot('web', () => undefined, () => undefined, root => ({ skills: join(root, 'office-skills') }))
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({
    kitRoot: undefined, assetRoot: join(root, 'office-skills'), node: undefined, cli: undefined, pythonEnvironment: 'user',
  })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect((await ctx.skills.get('office-docx'))?.resourceBase)
    .toEqual({ kind: 'directory', path: join(root, 'office-skills', 'office-docx').split(sep).join('/') })
})

it('fails only the Office rows when the carrier supplies an unusable primary runtime path', async () => {
  const { ctx } = await boot('desktop', () => 'primary-runtime')
  for (const id of ['skill-office', 'workspace-dependencies']) {
    await expect(ctx.loader.resolve(id).fiber!.await()).rejects.toThrow('absolute')
  }
  expect(await ctx.skills.list()).toEqual([])
  expect(ctx.tools.schemas()).toEqual([])
})
