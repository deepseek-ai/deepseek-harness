import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executableFileName } from '@deepseek-ai/dsh-cli-account'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import Wecom from '../src/index.ts'
import { createBinDir, ScriptedSubprocess } from './harness.ts'

const CONFIG = { commandTimeoutMs: 5_000, skillsUrls: ['https://codeload.github.com'], skillsTimeoutMs: 120_000 }

describe('WeCom plugin', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let binDir: string
  let skillsDir: string

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ScriptedSubprocess)
    await ctx.plugin(SystemPrompt)
    subprocess = ctx.subprocess as ScriptedSubprocess
    subprocess.respond = (process) => { process.reply({ stdout: 'unauthorized\n' }) }
    binDir = await createBinDir()
    skillsDir = await mkdtemp(join(tmpdir(), 'dsh-wecom-skills-'))
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(binDir, { recursive: true, force: true })
    await rm(skillsDir, { recursive: true, force: true })
  })

  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

  it('publishes one wecom entry skill over the configured guides, with a body that carries the DSH guidance', async () => {
    await ctx.plugin(Wecom, { ...CONFIG, binDir, skillsDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => `${skill.provider}/${skill.source}/${skill.name}`)).toEqual(['wecom/bundled/wecom'])

    const entry = await ctx.skills.get('wecom')
    expect(entry?.content).toContain('`wecom-cli` 由企业微信插件安装，按当前 runtime context 给出的绝对路径运行，不要直接按名称运行')
    expect(entry?.resourceBase).toEqual({ kind: 'directory', path: skillsDir })
    expect(await ctx.skills.get('wecomcli-shared')).toBeUndefined()
  })

  it('reports the guides as downloading and then failed when no skills URL answers, and lists no skill', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-wecom-home-'))
    vi.stubEnv('DSH_HOME', home)
    try {
      await ctx.plugin(Wecom, { ...CONFIG, binDir, skillsUrls: ['https://127.0.0.1:9'], skillsTimeoutMs: 5_000 })
      const seen: string[] = []
      for await (const view of ctx.wecom.follow(new AbortController().signal)) {
        seen.push(view.account.skills)
        if (view.account.skills === 'failed') break
      }
      expect(seen[0]).toBe('downloading')
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('gives the executable path and the script PATH prefix in runtime context, and withdraws them and the skills on disposal', async () => {
    const fiber = await ctx.plugin(Wecom, { ...CONFIG, binDir, skillsDir })
    expect(await runtimeContext()).toEqual([{
      name: 'wecom:cli',
      text: cliPathContextText({ name: 'wecom:cli', product: 'WeCom', program: 'wecom-cli', executable: join(binDir, executableFileName('wecom-cli')), scripts: true }, process.platform),
    }])
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  })
})
