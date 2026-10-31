/** Web application Office rows over a real Loader tree: skills, profile gating, Python, the preset office tool, and failure containment. */

import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import OfficeKit from '@deepseek-ai/dsh-office-kit'
import { resolveKitModule } from '@deepseek-ai/dsh-office-kit/locate'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolOffice from '@deepseek-ai/dsh-tool-office'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WorkspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

// Kit presence is the deployment fact under test; every other row runs unmodified.
vi.mock('@deepseek-ai/dsh-office-kit/locate', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-office-kit/locate')>()
  return { ...actual, resolveKitModule: vi.fn(() => ({ kind: 'missing', error: new Error('Cannot find package') })) }
})

const assets = fileURLToPath(new URL('../../../skill/skill-office/assets/', import.meta.url))
const names = ['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx']
const ROWS = ['office-kit', 'tool-office', 'workspace-dependencies', 'skill-office']

afterEach(() => { vi.unstubAllEnvs() })

/** Plugin rows of one shipped agent preset. */
function presetPlugins(preset: string): { id: string; name: string }[] {
  const [row] = loadOverlayPatches(preset, fileURLToPath(new URL(`../presets/${preset}.patch.yml`, import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
  return (row!.config as { plugins: { id: string; name: string }[] }).plugins
}

it('mounts the office tool in the standard and PTC presets and omits it from the minimal preset', () => {
  const office = (preset: string) => presetPlugins(preset).filter(row => row.id === 'tool-office').map(row => row.name)
  expect(office('standard')).toEqual(['@deepseek-ai/dsh-tool-office'])
  expect(office('ptc')).toEqual(['@deepseek-ai/dsh-tool-office'])
  expect(office('minimal')).toEqual([])
  const host = loadOverlayPatches('desktop-office', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).map(row => row.id)
  expect(host).not.toContain('tool-office')
})

async function boot(
  profile: string, primaryRuntime: (root: string) => string | undefined, skills: (root: string) => string | undefined = () => undefined,
  mounted: readonly string[] = ROWS,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-desktop-office-rows-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  vi.stubEnv('DSH_BUNDLED_PRIMARY_RUNTIME', primaryRuntime(root))
  vi.stubEnv('DSH_BUNDLED_OFFICE_SKILLS', skills(root))
  await cp(assets, join(root, 'office-skills'), { recursive: true })
  const nodePath = join(root, 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  await mkdir(dirname(nodePath), { recursive: true })
  await writeFile(nodePath, '')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', {
    name: profile, dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: join(root, 'package.json'),
    cwd: workspace, home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  ctx.provide('dshHomePath', dshHomePath)
  provideWorkingDirectoryFixture(ctx, workspace)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.dependencies = WorkspaceDependencies
  ctx.loader.builtins.office = SkillOffice
  ctx.loader.builtins.officeKit = OfficeKit
  ctx.loader.builtins.toolOffice = ToolOffice
  const builtin: Record<string, string> = {
    'office-kit': 'cordis:officeKit', 'tool-office': 'cordis:toolOffice', 'workspace-dependencies': 'cordis:dependencies', 'skill-office': 'cordis:office',
  }
  const hostRows = loadOverlayPatches('desktop-office', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => ROWS.includes(row.id))
  const rows = [...hostRows.slice(0, 1), presetPlugins('standard').find(row => row.id === 'tool-office')!, ...hostRows.slice(1)]
  expect(rows.map(row => row.id)).toEqual(ROWS)
  const entries = rows.map(row => ({ ...row, name: builtin[row.id]! }))
  await ctx.loader.root.update(entries.filter(row => mounted.includes(row.id)))
  await ctx.loader.await()
  return { ctx, root, workspace, entries }
}

it('mounts Desktop skills from the primary runtime beside the resident office tool', async () => {
  const { ctx, root } = await boot('desktop', root => join(root, 'primary-runtime'))
  // Desktop omits pythonEnvironment; the skill-office default selects the bundled environment.
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toEqual({
    assetRoot: join(root, 'office-skills'), pythonEnvironment: 'workspace-dependencies',
  })
  expect(ctx.loader.resolve('workspace-dependencies').fiber?.effectiveConfig).toEqual({
    source: join(root, 'primary-runtime'), root: join(root, 'home', 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['load_workspace_dependencies', 'office'])
  expect(ctx.officeKit.outputDirectory).toBe(join(root, 'home', 'office-kit', 'outputs'))
  expect((await ctx.skills.get('office-docx'))?.content).toMatch(/## Python environment\n\n.*`load_workspace_dependencies`/u)
  expect((await ctx.skills.get('office-render'))?.content).toContain('`office` tool')
})

it('keeps the office tool and returns the unavailable Kit error to the model when Kit is absent', async () => {
  const { ctx, workspace } = await boot('web', () => undefined)
  await writeFile(join(workspace, 'report.docx'), 'docx bytes')
  const warnings: string[] = []
  ctx.logger.exporter({ levels: { default: 2 }, export: ({ type, args }) => { if (type === 'warn') warnings.push(String(args[0])) } })
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal, callId: ToolCallId('office-missing-kit'), name: 'office',
    arguments: { operation: 'convert', input: 'report.docx', format: 'pdf' },
  })
  expect(result.isError).toBe(true)
  expect(result.content).toEqual([{ type: 'text', text: `Error: cannot convert "${join(workspace, 'report.docx')}": LibreOffice Kit is not installed. `
    + 'This deployment does not provide LibreOffice Kit; install or enable it as this deployment requires, then retry.' }])
  expect(resolveKitModule).toHaveBeenCalled()
  expect(warnings.filter(warning => warning.startsWith('OfficeKitError: LibreOffice Kit is not installed.'))).toHaveLength(1)
})

it('mounts the preset office tool without the Office kit row and reaches the service after the row loads', async () => {
  const { ctx, workspace, entries } = await boot('web', () => undefined, () => undefined, ROWS.filter(id => id !== 'office-kit'))
  vi.mocked(resolveKitModule).mockClear()
  await writeFile(join(workspace, 'report.docx'), 'docx bytes')
  await ctx.loader.resolve('tool-office').fiber!.await()
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['office'])
  const convert = () => executeToolFixture(ctx, {
    signal: new AbortController().signal, callId: ToolCallId('office-without-service'), name: 'office',
    arguments: { operation: 'convert', input: 'report.docx', format: 'pdf' },
  })
  expect((await convert()).content).toEqual([{ type: 'text', text: `Error: cannot convert "${join(workspace, 'report.docx')}": The document converter is unavailable.` }])
  expect(resolveKitModule).not.toHaveBeenCalled()
  await ctx.loader.root.update(entries)
  await ctx.loader.await()
  expect((await convert()).content).toEqual([{ type: 'text', text: expect.stringContaining('LibreOffice Kit is not installed.') as string }])
  expect(resolveKitModule).toHaveBeenCalled()
})

it('mounts Office skills with packaged defaults and the user Python outside the Desktop profile without launcher variables', async () => {
  const { ctx } = await boot('web', () => undefined)
  expect(ctx.loader.resolve('skill-office').disabled).toBe(false)
  // The path expression evaluates to `undefined`; the schema leaves it unset so skill-office applies its packaged default.
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({ assetRoot: undefined, pythonEnvironment: 'user' })
  expect(ctx.loader.resolve('workspace-dependencies').disabled).toBe(true)
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect((await ctx.skills.get('office-docx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-docx').split(sep).join('/') })
  const docx = (await ctx.skills.get('office-docx'))?.content
  expect(docx).toMatch(/## Python environment\n\n.*`python3` or `python` on PATH/u)
  expect(docx).not.toContain('load_workspace_dependencies')
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['office'])
})

it('mounts packaged Office skills with the user Python in a Desktop profile launched without a primary runtime', async () => {
  const { ctx } = await boot('desktop', () => undefined)
  // Both rows evaluate their expressions without a TypeError and validate their configuration.
  await ctx.loader.resolve('skill-office').fiber!.await()
  expect(ctx.loader.resolve('workspace-dependencies').disabled).toBe(true)
  expect(ctx.loader.resolve('workspace-dependencies').fiber).toBeUndefined()
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({ assetRoot: undefined, pythonEnvironment: 'user' })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect((await ctx.skills.get('office-docx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-docx').split(sep).join('/') })
  const docx = (await ctx.skills.get('office-docx'))?.content
  expect(docx).toMatch(/## Python environment\n\n.*`python3` or `python` on PATH/u)
  expect(docx).not.toContain('load_workspace_dependencies')
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['office'])
})

it('reads Office skills from the launcher skill directory outside the Desktop profile', async () => {
  const { ctx, root } = await boot('web', () => undefined, root => join(root, 'office-skills'))
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({ assetRoot: join(root, 'office-skills'), pythonEnvironment: 'user' })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect((await ctx.skills.get('office-docx'))?.resourceBase)
    .toEqual({ kind: 'directory', path: join(root, 'office-skills', 'office-docx').split(sep).join('/') })
})

it('fails only the Office skill rows when the carrier supplies an unusable primary runtime path', async () => {
  const { ctx } = await boot('desktop', () => 'primary-runtime')
  for (const id of ['skill-office', 'workspace-dependencies']) {
    await expect(ctx.loader.resolve(id).fiber!.await()).rejects.toThrow('absolute')
  }
  expect(await ctx.skills.list()).toEqual([])
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['office'])
})

it('removes the office tool when its row is disposed', async () => {
  const { ctx } = await boot('web', () => undefined)
  expect(ctx.tools.get('office')).toBeDefined()
  await ctx.loader.resolve('tool-office').fiber!.dispose()
  expect(ctx.tools.get('office')).toBeUndefined()
})
