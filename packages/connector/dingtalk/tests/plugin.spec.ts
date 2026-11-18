/**
 * The DingTalk Host row: one entry skill, the dws path in runtime context once installed, disposal of both, and the
 * cache directory of the profile that loads it.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import * as Dingtalk from '../src/index.ts'
import { DINGTALK_PACKAGE } from '../src/presentation.ts'
import { DWS_RELEASE, executableFileName } from '../src/release.ts'
import { closeHost, createHost, type DingtalkHost, type ScriptedSubprocess } from './harness.ts'

/** `binDir` and `skillsDir` download nothing, so the release prefix is never requested. */
const CONFIG = { releaseUrls: ['https://releases.invalid/download'], releaseTimeoutMs: 5_000 }

describe('DingTalk plugin', () => {
  let host: DingtalkHost
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let home: string
  let binDir: string
  let skillsDir: string

  beforeEach(async () => {
    host = await createHost()
    ;({ ctx, subprocess, home, binDir, skillsDir } = host)
  })

  afterEach(() => closeHost(host))

  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

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

  it('uses the cache directory of the profile that loads it, and deletes the earlier releases there', async () => {
    const owned = join(home, 'cache', 'dingtalk', 'web')
    await mkdir(join(owned, 'dws-skills-0.0.1'), { recursive: true })
    const dir = join(home, 'profiles', 'web')
    const profile: ProfileContext = {
      name: 'web', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: dir, cwd: home, home,
      startedBundles: [], overlayPaths: [], telemetryDisabledEnv: undefined,
    }
    ctx.provide('profileContext', profile)

    await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })

    const entry = await ctx.skills.get('dingtalk')
    const base = entry?.resourceBase?.kind === 'directory' ? entry.resourceBase.path : ''
    expect(base).toMatch(/[\\/]cache[\\/]dingtalk[\\/]web[\\/]skill-[0-9a-f]{16}[\\/]dingtalk$/u)
    await vi.waitFor(async () => { expect(await readdir(owned)).toEqual([basename(dirname(base))]) })
  })

  it('lists the skill and gives the dws path once a check publishes the skill root after the catalog was read', async () => {
    // The load-time check fails at once: nothing listens on this loopback port.
    await ctx.plugin(Dingtalk, { ...CONFIG, binDir, releaseUrls: ['https://127.0.0.1:1/download'] })
    expect(await ctx.skills.list()).toEqual([])
    expect(await runtimeContext()).toEqual([])

    await mkdir(join(home, 'cache', 'dingtalk', `dws-skills-${DWS_RELEASE.version}`, 'dingtalk-shared'), { recursive: true })
    await vi.waitFor(() => { void host.pages[0]!.source.start('check') })

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
      text: cliPathContextText(
        { product: 'DingTalk', program: 'dws', executable: join(binDir, executableFileName(process.platform)), scripts: true }, process.platform,
      ),
    }])
    expect(await ctx.skills.list()).not.toEqual([])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  })

  it('shows the account on the Plugins page while the registry runs, and withdraws it with the plugin', async () => {
    const fiber = await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })
    expect(host.pages).toHaveLength(1)
    expect(host.pages[0]).toMatchObject({ key: DINGTALK_PACKAGE, packageName: DINGTALK_PACKAGE })

    await fiber.dispose()

    expect(host.withdrawn).toBe(1)
  })

  it('defaults to the official release sources with a five-minute limit per source, and accepts only HTTPS URL prefixes, whole positive limits, and named directories', () => {
    expect(Dingtalk.Config()).toEqual({
      releaseUrls: [
        'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download',
        'https://gitee.com/dingtalk-real-ai/dingtalk-workspace-cli/releases/download',
      ],
      releaseTimeoutMs: 300_000,
    })
    expect(Dingtalk.Config({ ...CONFIG, releaseTimeoutMs: 1 }).releaseTimeoutMs).toBe(1)
    expect(Dingtalk.Config({ ...CONFIG, releaseUrls: ['https://mirror.example/dws/'] }).releaseUrls).toEqual(['https://mirror.example/dws/'])
    for (const url of [
      'http://releases.example/download', 'https://releases.example/?a=1', 'https://releases.example/#a', 'https://user@releases.example',
      'https://releases.example:bad', 'https://[', 'https://:',
    ]) {
      expect(() => Dingtalk.Config({ ...CONFIG, releaseUrls: [url] })).toThrow()
    }
    expect(() => Dingtalk.Config({ ...CONFIG, releaseUrls: [] })).toThrow()
    expect(() => Dingtalk.Config({ ...CONFIG, releaseTimeoutMs: 0 })).toThrow()
    expect(() => Dingtalk.Config({ ...CONFIG, releaseTimeoutMs: 1500.5 })).toThrow()
    expect(() => Dingtalk.Config({ ...CONFIG, binDir: '' })).toThrow()
    expect(() => Dingtalk.Config({ ...CONFIG, skillsDir: '' })).toThrow()
  })
})
