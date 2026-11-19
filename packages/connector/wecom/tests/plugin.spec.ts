import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import { executableFileName } from '../src/directory.ts'
import * as Wecom from '../src/index.ts'
import { WECOM_PACKAGE } from '../src/presentation.ts'
import { createHost, type WecomHost } from './harness.ts'

describe('Config', () => {
  it('takes the CLI directory and the guides directory, which are optional and never empty', () => {
    expect(Wecom.Config({})).toEqual({})
    expect(Wecom.Config({ binDir: '/opt/wecom/bin', skillsDir: '/opt/wecom/skills' })).toEqual({ binDir: '/opt/wecom/bin', skillsDir: '/opt/wecom/skills' })
    expect(() => Wecom.Config({ binDir: '' })).toThrow()
    expect(() => Wecom.Config({ skillsDir: '' })).toThrow()
  })
})

describe('WeCom plugin', () => {
  let host: WecomHost
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

  it('publishes one wecom entry skill over the configured guides, with a body that carries the DSH guidance', async () => {
    await start()
    await ctx.plugin(Wecom, { binDir, skillsDir })

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
      await start({ skillsUrls: ['https://127.0.0.1:9'], skillsTimeoutMs: 5_000 })
      await ctx.plugin(Wecom, { binDir })
      const account = host.pages[0]!.source
      expect(account.snapshot().account.skills).toBe('downloading')
      await vi.waitFor(() => { expect(account.snapshot().account.skills).toBe('failed') }, { timeout: 10_000 })
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('gives the executable path and the script PATH prefix in runtime context, and withdraws them and the skills on disposal', async () => {
    await start()
    const fiber = await ctx.plugin(Wecom, { binDir, skillsDir })
    expect(await runtimeContext()).toEqual([{
      name: 'wecom:cli',
      text: cliPathContextText({
        product: 'WeCom', program: 'wecom-cli', executable: join(binDir, executableFileName(process.platform)), scripts: true,
      }, process.platform),
    }])
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  })

  it('shows the authorization on the Plugins page while the registry runs, and withdraws it with the plugin', async () => {
    await start()
    const fiber = await ctx.plugin(Wecom, { binDir, skillsDir })
    expect(host.pages).toHaveLength(1)
    expect(host.pages[0]).toMatchObject({ key: WECOM_PACKAGE, packageName: WECOM_PACKAGE })
    expect(host.pages[0]!.source.snapshot().account).toEqual({ state: 'unchecked', skills: 'installed' })

    await fiber.dispose()

    expect(host.withdrawn).toBe(1)
  })
})
