/** The Windows-only provider registers through the shipped sandbox-local injection. */
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import { expect, it } from 'vitest'
import { ACL_DIAGNOSIS_SKILL } from '../src/acl-skill.ts'

// sandbox-local's POSIX suites are excluded on Windows; this owner runs in Windows coverage.
it.skipIf(process.platform !== 'win32')('loads and unloads the ACL skill through the real sandbox-local composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acl-composition-'))
  const ctx = new Context()
  try {
    // Loader persists disposal as disabled config; the committed seed stays read-only.
    const configPath = join(root, 'cordis.yml')
    await copyFile(new URL('./fixtures/skill-composition/cordis.yml', import.meta.url), configPath)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const unexpectedLoaderOperation = (): never => { throw new Error('This composition does not use Node HMR operations') }
    ctx.loader.internal = {
      version: 'v2',
      loadCache: new Map(),
      register: unexpectedLoaderOperation,
      getOrCreateModuleJob: unexpectedLoaderOperation,
      resolveSync: unexpectedLoaderOperation,
      load: unexpectedLoaderOperation,
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-skill') return SkillRegistry
        if (specifier === '@deepseek-ai/dsh-sandbox-local') return SandboxLocal
        throw new Error(`Unexpected Loader import: ${specifier}`)
      },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect((await ctx.skills.list()).map(entry => entry.name)).toEqual([ACL_DIAGNOSIS_SKILL])
    const loaded = await ctx.skills.get(ACL_DIAGNOSIS_SKILL)
    expect(loaded).toMatchObject({ source: 'bundled', provider: 'dsh-windows-acl' })
    expect(loaded?.content).toContain('Stop after any failed or refused repair')
    if (loaded?.resourceBase?.kind !== 'directory') throw new Error('Missing extracted skill resources')
    const resources = loaded.resourceBase.path
    expect(readFileSync(join(resources, 'scripts/diagnose-windows-sandbox-acl.ps1'), 'utf8'))
      .toBe(readFileSync(fileURLToPath(new URL('../assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1', import.meta.url)), 'utf8'))
    const sandbox = [...ctx.loader.entries()].find(entry => entry.options.id === 'sandbox')
    if (!sandbox?.fiber) throw new Error('Sandbox provider did not mount')
    await sandbox.fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(existsSync(resources)).toBe(false)
    await ctx.loader.create({
      name: '@deepseek-ai/dsh-sandbox-local',
      config: { runnerCommand: ['operator-runner'], runnerFailureSignatures: ['operator runner unavailable'] },
    })
    await ctx.loader.await()
    expect(await ctx.skills.list()).toEqual([])
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
