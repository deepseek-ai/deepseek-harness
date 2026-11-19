import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import { executableFileName } from '../src/cli.ts'
import * as Feishu from '../src/index.ts'
import { FEISHU_PACKAGE } from '../src/presentation.ts'
import { createHost, type FeishuHost, type ScriptedSubprocess } from './harness.ts'

const ENTRY = fileURLToPath(new URL('../skills/feishu/SKILL.md', import.meta.url))

describe('Config', () => {
  it('takes the CLI directory, which is optional and never empty', () => {
    expect(Feishu.Config({})).toEqual({})
    expect(Feishu.Config({ binDir: '/opt/lark/bin' })).toEqual({ binDir: '/opt/lark/bin' })
    expect(() => Feishu.Config({ binDir: '' })).toThrow()
  })
})

describe('Feishu plugin', () => {
  let host: FeishuHost
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let binDir: string
  let warnings: string[]

  beforeEach(async () => {
    host = await createHost()
    ;({ ctx, subprocess, binDir } = host)
    warnings = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(binDir, { recursive: true, force: true })
  })

  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

  it('lists the packaged feishu skill and loads its entry without running lark-cli', async () => {
    await ctx.plugin(Feishu, { binDir })

    expect(await ctx.skills.list()).toEqual([{
      name: 'feishu',
      description: expect.stringContaining('Load it before any Feishu or Lark task') as string,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'feishu',
      source: 'bundled',
      resourceBase: { kind: 'opaque', description: 'Embedded lark-cli guides; open them with the skills read command given in the loaded skill.' },
    }])

    const loaded = await ctx.skills.get('feishu')
    const file = await readFile(ENTRY, 'utf8')
    expect(loaded?.content.trim()).toBe(file.slice(file.indexOf('\n---\n', 4) + '\n---\n'.length).trim())
    expect(loaded?.content).toContain('# Feishu in DSH')
    expect(loaded?.content).toContain('open one with `lark-cli skills read <name>` in the Host Shell, not with the skill tool')
    expect(subprocess.lookups).toEqual([])
    expect(subprocess.processes).toEqual([])
    expect(warnings).toEqual([])
  })

  it('withdraws the runtime context and the skill on disposal', async () => {
    const fiber = await ctx.plugin(Feishu, { binDir })
    expect(await runtimeContext()).toEqual([{
      name: 'feishu:cli',
      text: cliPathContextText({ product: 'Feishu', program: 'lark-cli', executable: join(binDir, executableFileName(process.platform)) }, process.platform),
    }])
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['feishu'])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
    expect(warnings).toEqual([])
  })

  it('shows the account on the Plugins page while the registry runs, and withdraws it with the plugin', async () => {
    const fiber = await ctx.plugin(Feishu, { binDir })
    expect(host.pages).toHaveLength(1)
    expect(host.pages[0]).toMatchObject({ key: FEISHU_PACKAGE, packageName: FEISHU_PACKAGE })
    expect(host.pages[0]!.source.snapshot().account.state).toBe('unchecked')

    await fiber.dispose()

    expect(host.withdrawn).toBe(1)
  })
})
