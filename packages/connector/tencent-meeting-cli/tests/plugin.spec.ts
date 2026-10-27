import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
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
    await ctx.plugin(SystemPrompt)
    subprocess = ctx.subprocess as ScriptedSubprocess
    subprocess.respond = (process) => { process.reply({ stdout: 'Not logged in. Please use \'tmeet auth login\' to authenticate.\n' }) }
    binDir = await createBinDir()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(binDir, { recursive: true, force: true })
  })

  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

  it('publishes one tencent-meeting entry skill whose body carries the DSH guidance', async () => {
    await ctx.plugin(TencentMeeting, { ...CONFIG, binDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => `${skill.provider}/${skill.source}/${skill.name}`)).toEqual(['tencent-meeting/bundled/tencent-meeting'])

    const entry = await ctx.skills.get('tencent-meeting')
    expect(entry?.content).toContain('`tmeet` 由腾讯会议插件安装，按当前 runtime context 给出的绝对路径运行，不要直接按名称运行')
    expect(entry?.content).toContain('跳过运行 `scripts/agent_init.py` 的要求')
    expect(await ctx.skills.get('tmeet-skill')).toBeUndefined()
  })

  it('gives the executable path in runtime context, and withdraws it and the skills on disposal', async () => {
    const fiber = await ctx.plugin(TencentMeeting, { ...CONFIG, binDir })
    expect(await runtimeContext()).toEqual([{
      name: 'tencent-meeting:cli',
      text: `Tencent Meeting CLI: run \`tmeet\` by its absolute path "${join(binDir, 'tmeet')}"; the bare name may resolve to another installation or to none.`,
    }])
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  })
})
