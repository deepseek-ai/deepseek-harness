import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Feishu from '../src/index.ts'
import { byArguments, CATALOG, createBinDir, DOC_SKILL, ScriptedSubprocess } from './harness.ts'

const CONFIG = { commandTimeoutMs: 5_000 }
const LIST = 'skills list --json'
const READ = 'skills read lark-doc --json'

describe('Feishu plugin', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let binDir: string
  let warnings: string[]

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ScriptedSubprocess)
    await ctx.plugin(ShellEnv)
    subprocess = ctx.subprocess as ScriptedSubprocess
    binDir = await createBinDir()
    warnings = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(binDir, { recursive: true, force: true })
  })

  it('publishes embedded skills and loads each body after the DSH guidance', async () => {
    subprocess.respond = byArguments({ [LIST]: { stdout: JSON.stringify(CATALOG) }, [READ]: { stdout: JSON.stringify(DOC_SKILL) } })
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    const catalog = await ctx.skills.list()
    expect(catalog).toEqual(CATALOG.skills.map(({ name, description }) => ({
      name, description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'feishu',
      source: 'bundled',
      resourceBase: { kind: 'opaque', description: 'Embedded lark-cli references; use the skills read command given in the loaded skill.' },
    })))

    const loaded = await ctx.skills.get('lark-doc')
    const sections = loaded?.content.split('\n\n') ?? []
    expect(sections[0]).toBe('# Feishu in DSH')
    expect(sections.slice(-3)).toEqual(['# docs', 'Read documents.', DOC_SKILL.guidance])
    expect(loaded?.content).not.toContain('description: Feishu documents')
  })

  it('reads the catalog once per registration and keeps a failed catalog empty with one warning', async () => {
    subprocess.respond = byArguments({ [LIST]: { exitCode: 1, stderr: 'broken install' } })
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    expect(await ctx.skills.list()).toEqual([])
    expect(await ctx.skills.list({ cwd: '/elsewhere' })).toEqual([])
    expect(subprocess.processes).toHaveLength(1)
    expect(warnings).toEqual(['feishu: skills unavailable until the plugin reloads: Error: lark-cli skills list --json exited with 1: broken install'])
  })

  it('names the catalog command when its JSON does not match the catalog format', async () => {
    subprocess.respond = byArguments({ [LIST]: { stdout: JSON.stringify({ ok: true, skills: [{ name: 'Not A Skill', description: 'x' }] }) } })
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    expect(await ctx.skills.list()).toEqual([])
    expect(warnings).toEqual(['feishu: skills unavailable until the plugin reloads: Error: lark-cli skills list --json returned an unexpected catalog'])
  })

  it('refuses to load without a Host subprocess runtime', () => {
    subprocess.host = false

    expect(() => new Feishu(ctx, { ...CONFIG, binDir })).toThrow('feishu: lark-cli and its default account are local to this Host')
    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBeUndefined()
  })

  it.each([
    [{ ...DOC_SKILL, skill: 'lark-im' }],
    [{ ...DOC_SKILL, path: 'references/a.md' }],
    [{ ...DOC_SKILL, content: '# no frontmatter' }],
    [{ skill: 'lark-doc', path: 'SKILL.md', content: DOC_SKILL.content }],
  ])('rejects an unexpected skill document %#', async (document) => {
    subprocess.respond = byArguments({ [LIST]: { stdout: JSON.stringify(CATALOG) }, [READ]: { stdout: JSON.stringify(document) } })
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    await expect(ctx.skills.get('lark-doc')).rejects.toThrow('lark-cli skills read lark-doc --json returned an unexpected skill document')
  })

  it('terminates a skill read when the lookup is cancelled', async () => {
    const lookup = new AbortController()
    subprocess.respond = (process) => {
      if (process.spec.argv.includes('list')) process.reply({ stdout: JSON.stringify(CATALOG) })
      else lookup.abort(new Error('lookup cancelled'))
    }
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    await expect(ctx.skills.get('lark-doc', { signal: lookup.signal })).rejects.toThrow('lookup cancelled')
    await vi.waitFor(() => { expect(subprocess.processes[1]?.terminated).toBe(true) })
  })

  it('withdraws the private PATH and skills on disposal after owned processes exit, without a warning', async () => {
    subprocess.respond = (process) => { process.holdExit = true }
    const fiber = await ctx.plugin(Feishu, { ...CONFIG, binDir })
    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBe(binDir)
    void ctx.skills.list()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })

    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(subprocess.processes[0]?.terminated).toBe(true) })
    expect(disposed).toBe(false)
    subprocess.processes[0]?.release()
    await disposal

    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBeUndefined()
    expect(await ctx.skills.list()).toEqual([])
    expect(warnings).toEqual([])
  })
})
