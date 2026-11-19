import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import { executableFileName } from '../src/directory.ts'
import * as TencentMeeting from '../src/index.ts'
import { TENCENT_MEETING_PACKAGE } from '../src/presentation.ts'
import { createHost, type TencentMeetingHost } from './harness.ts'

describe('Config', () => {
  it('takes the CLI directory and the guide directory, which are optional and never empty', () => {
    expect(TencentMeeting.Config({})).toEqual({})
    expect(TencentMeeting.Config({ binDir: '/opt/tmeet/bin', skillsDir: '/opt/tmeet/skills' })).toEqual({ binDir: '/opt/tmeet/bin', skillsDir: '/opt/tmeet/skills' })
    expect(() => TencentMeeting.Config({ binDir: '' })).toThrow()
    expect(() => TencentMeeting.Config({ skillsDir: '' })).toThrow()
  })
})

describe('Tencent Meeting plugin', () => {
  let host: TencentMeetingHost
  let ctx: Context
  let binDir: string
  let skillsDir: string

  /** Start the Host the plugin loads on; the upstream skills Service downloads from `skills`. */
  async function start(skills?: Parameters<typeof createHost>[0]): Promise<void> {
    host = await createHost(skills)
    ;({ ctx, binDir, skillsDir } = host)
  }

  afterEach(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(binDir, { recursive: true, force: true })
    await rm(skillsDir, { recursive: true, force: true })
  })

  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

  it('publishes one tencent-meeting entry skill over the configured guide, with a body that carries the DSH guidance', async () => {
    await start()
    await ctx.plugin(TencentMeeting, { binDir, skillsDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => `${skill.provider}/${skill.source}/${skill.name}`)).toEqual(['tencent-meeting/bundled/tencent-meeting'])

    const entry = await ctx.skills.get('tencent-meeting')
    expect(entry?.content).toContain('`tmeet` 由腾讯会议插件安装，按当前 runtime context 给出的绝对路径运行，不要直接按名称运行')
    expect(entry?.content).toContain('跳过运行 `scripts/agent_init.py` 的要求')
    expect(entry?.resourceBase).toEqual({ kind: 'directory', path: skillsDir })
    expect(await ctx.skills.get('tmeet-skill')).toBeUndefined()
  })

  it('reports the guide as downloading and then failed when no skills URL answers, and lists no skill', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-tencent-meeting-home-'))
    vi.stubEnv('DSH_HOME', home)
    try {
      await start({ skillsUrls: ['https://127.0.0.1:9'], skillsTimeoutMs: 5_000 })
      await ctx.plugin(TencentMeeting, { binDir })
      const account = host.pages[0]!.source
      expect(account.snapshot().account.skills).toBe('downloading')
      await vi.waitFor(() => { expect(account.snapshot().account.skills).toBe('failed') }, { timeout: 10_000 })
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('gives the executable path in runtime context, and withdraws it and the skills on disposal', async () => {
    await start()
    const fiber = await ctx.plugin(TencentMeeting, { binDir, skillsDir })
    expect(await runtimeContext()).toEqual([{
      name: 'tencent-meeting:cli',
      text: cliPathContextText({
        product: 'Tencent Meeting', program: 'tmeet', executable: join(binDir, executableFileName(process.platform)),
      }, process.platform),
    }])
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  })

  it('shows the account on the Plugins page while the registry runs, and withdraws it with the plugin', async () => {
    await start()
    const fiber = await ctx.plugin(TencentMeeting, { binDir, skillsDir })
    expect(host.pages).toHaveLength(1)
    expect(host.pages[0]).toMatchObject({ key: TENCENT_MEETING_PACKAGE, packageName: TENCENT_MEETING_PACKAGE })
    expect(host.pages[0]!.source.snapshot().account).toEqual({ state: 'unchecked', skills: 'installed' })

    await fiber.dispose()

    expect(host.withdrawn).toBe(1)
  })
})
