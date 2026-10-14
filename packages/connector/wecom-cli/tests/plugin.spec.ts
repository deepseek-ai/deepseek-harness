import { readdir, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Wecom from '../src/index.ts'
import { createBinDir, ScriptedSubprocess } from './harness.ts'

const CONFIG = { commandTimeoutMs: 5_000 }
const SKILLS_DIR = new URL('../skills/', import.meta.url)

describe('WeCom plugin', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let binDir: string

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ScriptedSubprocess)
    await ctx.plugin(ShellEnv)
    subprocess = ctx.subprocess as ScriptedSubprocess
    subprocess.respond = (process) => { process.reply({ stdout: 'unauthorized\n' }) }
    binDir = await createBinDir()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(binDir, { recursive: true, force: true })
  })

  it('publishes the bundled skills under the wecom provider and loads the DSH-adapted shared skill', async () => {
    await ctx.plugin(Wecom, { ...CONFIG, binDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => skill.name).sort()).toEqual((await readdir(SKILLS_DIR)).sort())
    expect(new Set(catalog.map(skill => `${skill.provider}/${skill.source}`))).toEqual(new Set(['wecom/bundled']))

    const shared = await ctx.skills.get('wecomcli-shared')
    expect(shared?.content).toContain('在 DSH 中，`wecom-cli` 由企业微信插件安装并加入 Host Shell 的 PATH')
  })

  it('refuses to load without a Host subprocess runtime', () => {
    subprocess.host = false

    expect(() => new Wecom(ctx, { ...CONFIG, binDir })).toThrow('wecom: wecom-cli and its authorization are local to this Host')
    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBeUndefined()
  })

  it('withdraws the private PATH and skills on disposal', async () => {
    const fiber = await ctx.plugin(Wecom, { ...CONFIG, binDir })
    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBe(binDir)
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBeUndefined()
    expect(await ctx.skills.list()).toEqual([])
  })
})
