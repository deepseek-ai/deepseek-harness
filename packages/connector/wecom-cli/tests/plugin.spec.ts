import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Wecom from '../src/index.ts'
import { createBinDir, ScriptedSubprocess } from './harness.ts'

const CONFIG = { commandTimeoutMs: 5_000 }

describe('WeCom plugin', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let binDir: string

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ScriptedSubprocess)
    await ctx.plugin(SystemPrompt)
    subprocess = ctx.subprocess as ScriptedSubprocess
    subprocess.respond = (process) => { process.reply({ stdout: 'unauthorized\n' }) }
    binDir = await createBinDir()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(binDir, { recursive: true, force: true })
  })

  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

  it('publishes one wecom entry skill whose body carries the DSH guidance', async () => {
    await ctx.plugin(Wecom, { ...CONFIG, binDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => `${skill.provider}/${skill.source}/${skill.name}`)).toEqual(['wecom/bundled/wecom'])

    const entry = await ctx.skills.get('wecom')
    expect(entry?.content).toContain('`wecom-cli` 由企业微信插件安装，按当前 runtime context 给出的绝对路径运行，不要直接按名称运行')
    expect(await ctx.skills.get('wecomcli-shared')).toBeUndefined()
  })

  it('gives the executable path and the script PATH prefix in runtime context, and withdraws them and the skills on disposal', async () => {
    const fiber = await ctx.plugin(Wecom, { ...CONFIG, binDir })
    expect(await runtimeContext()).toEqual([{
      name: 'wecom:cli',
      text: `WeCom CLI: run \`wecom-cli\` by its absolute path "${join(binDir, 'wecom-cli')}"; the bare name may resolve to another installation or to none.\n`
        + `Scripts in the WeCom skill call \`wecom-cli\` by name; prefix only the commands that run them with PATH="${binDir}:$PATH", and never export PATH or run \`wecom-cli\` by name yourself.`,
    }])
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  })
})
