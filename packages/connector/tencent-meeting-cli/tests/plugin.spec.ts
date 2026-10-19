import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TencentMeeting from '../src/index.ts'
import { createBinDir, ScriptedSubprocess } from './harness.ts'

const CONFIG = { commandTimeoutMs: 5_000 }

describe('Tencent Meeting plugin', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let binDir: string

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ScriptedSubprocess)
    await ctx.plugin(ShellEnv)
    subprocess = ctx.subprocess as ScriptedSubprocess
    subprocess.respond = (process) => { process.reply({ stdout: 'Not logged in. Please use \'tmeet auth login\' to authenticate.\n' }) }
    binDir = await createBinDir()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(binDir, { recursive: true, force: true })
  })

  it('publishes one tencent-meeting entry skill whose body carries the DSH guidance', async () => {
    await ctx.plugin(TencentMeeting, { ...CONFIG, binDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => `${skill.provider}/${skill.source}/${skill.name}`)).toEqual(['tencent-meeting/bundled/tencent-meeting'])

    const entry = await ctx.skills.get('tencent-meeting')
    expect(entry?.content).toContain('`tmeet` 由腾讯会议插件安装并加入 Host Shell 的 PATH')
    expect(entry?.content).toContain('跳过运行 `scripts/agent_init.py` 的要求')
    expect(await ctx.skills.get('tmeet-skill')).toBeUndefined()
  })

  it('refuses to load without a Host subprocess runtime', () => {
    subprocess.host = false

    expect(() => new TencentMeeting(ctx, { ...CONFIG, binDir })).toThrow('tencent-meeting: tmeet and its default sign-in are local to this Host')
    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBeUndefined()
  })

  it('withdraws the private PATH and skills on disposal', async () => {
    const fiber = await ctx.plugin(TencentMeeting, { ...CONFIG, binDir })
    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBe(binDir)
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBeUndefined()
    expect(await ctx.skills.list()).toEqual([])
  })
})
