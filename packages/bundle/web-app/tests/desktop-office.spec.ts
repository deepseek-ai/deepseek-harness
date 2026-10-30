/** Desktop Office rows over a real Loader tree: carrier paths, profile gating, and per-row failure containment. */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WorkspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

const assets = fileURLToPath(new URL('../../../skill/skill-office/assets/', import.meta.url))
const names = ['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx']

afterEach(() => { vi.unstubAllEnvs() })

async function boot(profile: string, primaryRuntime: (root: string) => string | undefined,
  officeCli: (root: string) => string | undefined = root => join(root, 'office-cli.js')) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-office-rows-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  vi.stubEnv('DSH_BUNDLED_PRIMARY_RUNTIME', primaryRuntime(root))
  vi.stubEnv('DSH_BUNDLED_OFFICE_CLI', officeCli(root))
  await cp(assets, join(root, 'office-skills'), { recursive: true })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', {
    name: profile, dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
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
  return { ctx, root }
}

it('mounts Office skills and workspace dependencies from the Desktop carrier paths', async () => {
  const { ctx, root } = await boot('desktop', root => join(root, 'primary-runtime'))
  expect(ctx.loader.resolve('skill-office').fiber?.config).toEqual({
    assetRoot: join(root, 'office-skills'),
    node: join(root, 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    cli: join(root, 'office-cli.js'),
  })
  expect(ctx.loader.resolve('workspace-dependencies').fiber?.config).toEqual({
    source: join(root, 'primary-runtime'), root: join(root, 'home', 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['load_workspace_dependencies'])
})

it('keeps Office skills without CLI paths when the Desktop shell supplies no Kit CLI', async () => {
  const { ctx, root } = await boot('desktop', root => join(root, 'primary-runtime'), () => undefined)
  expect(ctx.loader.resolve('skill-office').fiber?.config).toMatchObject({ assetRoot: join(root, 'office-skills'), cli: false })
  expect(ctx.loader.resolve('workspace-dependencies').fiber?.config).toEqual({
    source: join(root, 'primary-runtime'), root: join(root, 'home', 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
  for (const name of ['office-render', 'office-recalculate', 'office-export-pdf']) {
    const content = (await ctx.skills.get(name))?.content
    expect(content).toMatch(/\n\nLibreOffice Kit is disabled in this deployment\.$/u)
    expect(content).not.toContain('libreofficeKit')
  }
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['load_workspace_dependencies'])
})

it('keeps both rows disabled outside the Desktop profile', async () => {
  const { ctx } = await boot('web', () => undefined)
  expect(ctx.loader.resolve('skill-office').disabled).toBe(true)
  expect(ctx.loader.resolve('workspace-dependencies').disabled).toBe(true)
  expect(await ctx.skills.list()).toEqual([])
  expect(ctx.tools.schemas()).toEqual([])
})

it('fails only the Office rows when the carrier supplies an unusable primary runtime path', async () => {
  const { ctx } = await boot('desktop', () => 'primary-runtime')
  for (const id of ['skill-office', 'workspace-dependencies']) {
    await expect(ctx.loader.resolve(id).fiber!.await()).rejects.toThrow('absolute')
  }
  expect(await ctx.skills.list()).toEqual([])
  expect(ctx.tools.schemas()).toEqual([])
})
