/** The DingTalk Host row: one entry skill, the dws path in runtime context once installed, and disposal of both. */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executableFileName } from '@deepseek-ai/dsh-cli-account'
import type { ConnectorAccountRegistration } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import * as Dingtalk from '../src/index.ts'
import { COPY, DINGTALK_PACKAGE, OPERATIONS, presentAccount } from '../src/presentation.ts'
import type { DingtalkState } from '../src/types.ts'
import { DWS_RELEASE } from '../src/release.ts'
import { createBinDir, createSkillsDir, ScriptedSubprocess } from './harness.ts'

/** `binDir` and `skillsDir` download nothing, so the release prefix is never requested. */
const CONFIG = { commandTimeoutMs: 5_000, releaseUrls: ['https://releases.invalid/download'], releaseTimeoutMs: 5_000 }

describe('DingTalk plugin', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let home: string
  let binDir: string
  let skillsDir: string

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ScriptedSubprocess)
    await ctx.plugin(SystemPrompt)
    subprocess = ctx.subprocess as ScriptedSubprocess
    subprocess.respond = (process) => { process.reply({ stdout: '{"success": true, "authenticated": false, "message": "未登录"}\n' }) }
    home = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-home-'))
    vi.stubEnv('DSH_HOME', home)
    binDir = await createBinDir()
    skillsDir = await createSkillsDir()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
    await rm(binDir, { recursive: true, force: true })
    await rm(skillsDir, { recursive: true, force: true })
  })

  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

  /** Stand in for the connector account registry the Web app provides, and keep what the plugin registers with it. */
  function provideRegistry() {
    const registered: ConnectorAccountRegistration<DingtalkState>[] = []
    const withdrawn = vi.fn()
    ctx.provide('connectorAccounts', {
      register: (registration: ConnectorAccountRegistration<DingtalkState>) => {
        registered.push(registration)
        return withdrawn
      },
    })
    return { registered, withdrawn }
  }

  it('publishes one dingtalk entry skill whose guides resolve from its base directory', async () => {
    await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => `${skill.provider}/${skill.source}/${skill.name}`)).toEqual(['dingtalk/bundled/dingtalk'])

    const entry = await ctx.skills.get('dingtalk')
    expect(entry?.content).toContain('`dws` 由钉钉插件下载，按当前 runtime context 给出的绝对路径运行，不要直接按名称运行')
    expect(entry?.content).toContain('不要运行 `dws skill setup`')
    expect(entry?.resourceBase?.kind).toBe('directory')
    const base = entry?.resourceBase?.kind === 'directory' ? entry.resourceBase.path : ''
    expect(base).toMatch(/[\\/]cache[\\/]dingtalk[\\/]skill-[0-9a-f]{16}[\\/]dingtalk$/u)
    expect(await readFile(join(base, 'guides', 'dingtalk-shared', 'SKILL.md'), 'utf8')).toContain('# Fixture guide')
    expect(await ctx.skills.get('dingtalk-shared')).toBeUndefined()
  })

  it('lists the skill and gives the dws path once a check publishes the skill root after the catalog was read', async () => {
    // The load-time check fails at once: nothing listens on this loopback port.
    const registry = provideRegistry()
    await ctx.plugin(Dingtalk, { ...CONFIG, binDir, releaseUrls: ['https://127.0.0.1:1/download'] })
    expect(await ctx.skills.list()).toEqual([])
    expect(await runtimeContext()).toEqual([])

    await mkdir(join(home, 'cache', 'dingtalk', `dws-skills-${DWS_RELEASE.version}`, 'dingtalk-shared'), { recursive: true })
    await vi.waitFor(() => { void registry.registered[0]!.source.start('check') })

    await vi.waitFor(async () => {
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['dingtalk'])
    }, { timeout: 10_000, interval: 50 })
    await vi.waitFor(() => {
      expect(subprocess.processes.map(process => process.spec.argv.slice(1).join(' '))).toEqual(['auth status --format json'])
    })
    expect((await runtimeContext()).map(section => section.name)).toEqual(['dingtalk:cli'])
  })

  it('gives the dws path and the script PATH prefix in runtime context, and withdraws them and the skills on disposal', async () => {
    const fiber = await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })
    expect(await runtimeContext()).toEqual([{
      name: 'dingtalk:cli',
      text: cliPathContextText({ name: 'dingtalk:cli', product: 'DingTalk', program: 'dws', executable: join(binDir, executableFileName('dws')), scripts: true }, process.platform),
    }])
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  })

  it('shows the account on the Plugins page while the registry runs, and withdraws it with the plugin', async () => {
    const registry = provideRegistry()
    const fiber = await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })
    expect(registry.registered).toHaveLength(1)
    expect(registry.registered[0]).toMatchObject({
      packageName: DINGTALK_PACKAGE, operations: OPERATIONS, copy: COPY, present: presentAccount,
    })

    await fiber.dispose()

    expect(registry.withdrawn).toHaveBeenCalledOnce()
  })

  it('defaults to the official release sources with a five-minute limit per source, and accepts only whole positive limits', () => {
    expect(Dingtalk.Config()).toMatchObject({
      releaseUrls: [
        'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download',
        'https://gitee.com/dingtalk-real-ai/dingtalk-workspace-cli/releases/download',
      ],
      releaseTimeoutMs: 300_000,
    })
    expect(Dingtalk.Config({ ...CONFIG, releaseTimeoutMs: 1 }).releaseTimeoutMs).toBe(1)
    expect(() => Dingtalk.Config({ ...CONFIG, releaseTimeoutMs: 0 })).toThrow()
    expect(() => Dingtalk.Config({ ...CONFIG, releaseTimeoutMs: 1500.5 })).toThrow()
  })
})
