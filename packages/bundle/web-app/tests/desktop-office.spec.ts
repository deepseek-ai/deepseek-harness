/** Web application Office rows over a real Loader tree: skills, profile gating, Python, preset Office tools, and failure containment. */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import OfficeKit from '@deepseek-ai/dsh-office-kit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveKitModule } from '@deepseek-ai/dsh-office-kit/src/locate.ts'
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
vi.mock('@deepseek-ai/dsh-office-kit/src/locate.ts', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-office-kit/src/locate.ts')>()
  return { ...actual, resolveKitModule: vi.fn(() => ({ kind: 'missing', error: new Error('Cannot find package') })) }
})

const assets = fileURLToPath(new URL('../../../skill/skill-office/assets/', import.meta.url))
const names = ['office', 'office-docx', 'office-pptx', 'office-xlsx']
const ROWS = ['office-kit', 'tool-office', 'workspace-dependencies', 'skill-office']
const OFFICE_TOOLS = ['office_convert', 'office_recalculate', 'office_render']

afterEach(() => { vi.unstubAllEnvs() })

/** Plugin rows of one shipped agent preset. */
function presetPlugins(preset: string): { id: string; name: string }[] {
  const [row] = loadOverlayPatches(preset, fileURLToPath(new URL(`../presets/${preset}.patch.yml`, import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
  return (row!.config as { plugins: { id: string; name: string }[] }).plugins
}

it('mounts the Office tools in the standard and PTC presets and omits it from the minimal preset', () => {
  const office = (preset: string) => presetPlugins(preset).filter(row => row.id === 'tool-office').map(row => row.name)
  expect(office('standard')).toEqual(['@deepseek-ai/dsh-tool-office'])
  expect(office('ptc')).toEqual(['@deepseek-ai/dsh-tool-office'])
  expect(office('minimal')).toEqual([])
  const host = loadOverlayPatches('desktop-office', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).map(row => row.id)
  expect(host).not.toContain('tool-office')
})

async function boot(profile: string, primaryRuntime: (root: string) => string | undefined, mounted: readonly string[] = ROWS) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-desktop-office-rows-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  vi.stubEnv('DSH_PRIMARY_RUNTIME', primaryRuntime(root))
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
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
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

/** Convert through `office_convert` as an Agent whose previous request declared the Office tools. */
async function convertReport(ctx: Context, workspace: string, callId: string) {
  const id = SessionId(callId)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: workspace, isSeeded: false })
  vi.spyOn(session, 'requestHeader').mockReturnValue({ config: { provider: 'fixture', model: 'fixture' }, tools: ctx.tools.schemas() })
  const agent = { session, options: {} } as never
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal })
  try {
    return await executeToolFixture(ctx, {
      signal, callId: ToolCallId(callId), name: 'office_convert', agent, toolSet, arguments: { input: 'report.docx', format: 'pdf' },
    })
  } finally { toolSet.dispose() }
}

it('mounts packaged Desktop skills with the primary runtime Python beside the Office tools', async () => {
  const { ctx, root } = await boot('desktop', root => join(root, 'primary-runtime'))
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({ pythonEnvironment: 'workspace-dependencies' })
  expect(ctx.loader.resolve('workspace-dependencies').fiber?.effectiveConfig).toEqual({
    source: join(root, 'primary-runtime'), root: join(root, 'home', 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect((await ctx.skills.get('office-docx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-docx').split(sep).join('/') })
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['load_workspace_dependencies', ...OFFICE_TOOLS])
  expect(ctx.officeKit.outputDirectory).toBe(join(root, 'home', 'office-kit', 'outputs'))
  expect((await ctx.skills.get('office-docx'))?.content).toMatch(/## Python environment\n\n.*`load_workspace_dependencies`/u)
  expect((await ctx.skills.get('office'))?.content).toContain('`office_convert`')
})

it('keeps the Office tools and returns the unavailable Kit error to the model when Kit is absent', async () => {
  const { ctx, workspace } = await boot('web', () => undefined)
  await writeFile(join(workspace, 'report.docx'), 'docx bytes')
  const warnings: string[] = []
  ctx.logger.exporter({ levels: { default: 2 }, export: ({ type, args }) => { if (type === 'warn') warnings.push(String(args[0])) } })
  const result = await convertReport(ctx, workspace, 'office-missing-kit')
  expect(result.isError).toBe(true)
  expect(result.content).toEqual([{ type: 'text', text: `Error: cannot convert "${join(workspace, 'report.docx')}": LibreOffice Kit is not installed. `
    + 'This deployment does not provide LibreOffice Kit; install or enable it as this deployment requires, then retry.'
    + ' Tell the user this operation is unavailable, or retry later if the cause may be temporary; do not substitute system soffice, npx, or another converter.' }])
  expect(resolveKitModule).toHaveBeenCalled()
  expect(warnings.filter(warning => warning.startsWith('OfficeKitError: LibreOffice Kit is not installed.'))).toHaveLength(1)
})

it('mounts the preset Office tools without the Office kit row and reaches the service after the row loads', async () => {
  const { ctx, workspace, entries } = await boot('web', () => undefined, ROWS.filter(id => id !== 'office-kit'))
  vi.mocked(resolveKitModule).mockClear()
  await writeFile(join(workspace, 'report.docx'), 'docx bytes')
  await ctx.loader.resolve('tool-office').fiber!.await()
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(OFFICE_TOOLS)
  const convert = () => convertReport(ctx, workspace, 'office-without-service')
  expect((await convert()).content).toEqual([{ type: 'text', text: 'Error: cannot convert "report.docx": The document converter is unavailable.'
    + ' Tell the user this operation is unavailable, or retry later if the cause may be temporary; do not substitute system soffice, npx, or another converter.' }])
  expect(resolveKitModule).not.toHaveBeenCalled()
  await ctx.loader.root.update(entries)
  await ctx.loader.await()
  expect((await convert()).content).toEqual([{ type: 'text', text: expect.stringContaining('LibreOffice Kit is not installed.') as string }])
  expect(resolveKitModule).toHaveBeenCalled()
})

it('mounts Office skills with packaged defaults and the user Python outside the Desktop profile without launcher variables', async () => {
  const { ctx } = await boot('web', () => undefined)
  expect(ctx.loader.resolve('skill-office').disabled).toBe(false)
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({ pythonEnvironment: 'user' })
  expect(ctx.loader.resolve('workspace-dependencies').disabled).toBe(true)
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect((await ctx.skills.get('office-docx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-docx').split(sep).join('/') })
  const docx = (await ctx.skills.get('office-docx'))?.content
  expect(docx).toMatch(/## Python environment\n\n.*`python3` or `python` on PATH/u)
  expect(docx).not.toContain('load_workspace_dependencies')
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(OFFICE_TOOLS)
})

it('mounts packaged Office skills with the user Python in a Desktop profile launched without a primary runtime', async () => {
  const { ctx } = await boot('desktop', () => undefined)
  // Both rows evaluate their expressions without a TypeError and validate their configuration.
  await ctx.loader.resolve('skill-office').fiber!.await()
  expect(ctx.loader.resolve('workspace-dependencies').disabled).toBe(true)
  expect(ctx.loader.resolve('workspace-dependencies').fiber).toBeUndefined()
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({ pythonEnvironment: 'user' })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect((await ctx.skills.get('office-docx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-docx').split(sep).join('/') })
  const docx = (await ctx.skills.get('office-docx'))?.content
  expect(docx).toMatch(/## Python environment\n\n.*`python3` or `python` on PATH/u)
  expect(docx).not.toContain('load_workspace_dependencies')
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(OFFICE_TOOLS)
})

it('treats an empty primary runtime variable as unset in the Desktop profile', async () => {
  const { ctx } = await boot('desktop', () => '')
  await ctx.loader.resolve('skill-office').fiber!.await()
  expect(ctx.loader.resolve('workspace-dependencies').disabled).toBe(true)
  expect(ctx.loader.resolve('skill-office').fiber?.effectiveConfig).toStrictEqual({ pythonEnvironment: 'user' })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
})

it('fails only the dependency-query row when the carrier supplies an unusable primary runtime path', async () => {
  const { ctx } = await boot('desktop', () => 'primary-runtime')
  await expect(ctx.loader.resolve('workspace-dependencies').fiber!.await()).rejects.toThrow('absolute')
  await ctx.loader.resolve('skill-office').fiber!.await()
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(OFFICE_TOOLS)
})

it('removes the Office tools when their row is disposed', async () => {
  const { ctx } = await boot('web', () => undefined)
  for (const name of OFFICE_TOOLS) expect(ctx.tools.get(name)).toBeDefined()
  await ctx.loader.resolve('tool-office').fiber!.dispose()
  for (const name of OFFICE_TOOLS) expect(ctx.tools.get(name)).toBeUndefined()
})
