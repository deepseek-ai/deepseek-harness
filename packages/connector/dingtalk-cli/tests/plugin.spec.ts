/** The DingTalk Host row: one entry skill, a Host-only subprocess runtime, and disposal of its PATH and skills. */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dingtalk from '../src/index.ts'
import { DWS_RELEASE } from '../src/release.ts'
import { createBinDir, createSkillsDir, ScriptedSubprocess } from './harness.ts'

/** `binDir` and `skillsDir` download nothing, so the release prefix is never requested. */
const CONFIG = { commandTimeoutMs: 5_000, releaseUrls: ['https://releases.invalid/download'] }

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
    await ctx.plugin(ShellEnv)
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

  it('publishes one dingtalk entry skill whose guides resolve from its base directory', async () => {
    await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => `${skill.provider}/${skill.source}/${skill.name}`)).toEqual(['dingtalk/bundled/dingtalk'])

    const entry = await ctx.skills.get('dingtalk')
    expect(entry?.content).toContain('`dws` 由钉钉插件下载并加入 Host Shell 的 PATH')
    expect(entry?.content).toContain('不要运行 `dws skill setup`')
    expect(entry?.resourceBase?.kind).toBe('directory')
    const base = entry?.resourceBase?.kind === 'directory' ? entry.resourceBase.path : ''
    expect(base).toMatch(/\/cache\/dingtalk\/skill-[0-9a-f]{16}\/dingtalk$/u)
    expect(await readFile(join(base, 'guides', 'dingtalk-shared', 'SKILL.md'), 'utf8')).toContain('# Fixture guide')
    expect(await ctx.skills.get('dingtalk-shared')).toBeUndefined()
  })

  it('lists the skill once a check publishes its root after the catalog was read', async () => {
    // The load-time check fails at once: nothing listens on this loopback port.
    await ctx.plugin(Dingtalk, { ...CONFIG, binDir, releaseUrls: ['https://127.0.0.1:1/download'] })
    expect(await ctx.skills.list()).toEqual([])

    await mkdir(join(home, 'cache', 'dingtalk', `dws-skills-${DWS_RELEASE.version}`, 'dingtalk-shared'), { recursive: true })
    await vi.waitFor(() => { ctx.dingtalk.check() })

    await vi.waitFor(async () => {
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['dingtalk'])
    }, { timeout: 10_000, interval: 50 })
    await vi.waitFor(() => {
      expect(subprocess.processes.map(process => process.spec.argv.slice(1).join(' '))).toEqual(['auth status --format json'])
    })
  })

  it('refuses to load without a Host subprocess runtime', () => {
    subprocess.host = false

    expect(() => new Dingtalk(ctx, { ...CONFIG, binDir, skillsDir })).toThrow('dingtalk: dws and its sign-in are local to this Host')
    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBeUndefined()
  })

  it('withdraws the private PATH and skills on disposal', async () => {
    const fiber = await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })
    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBe(binDir)
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(ctx.shellEnv.getPathPrefix(ctx.subprocess)).toBeUndefined()
    expect(await ctx.skills.list()).toEqual([])
  })
})
