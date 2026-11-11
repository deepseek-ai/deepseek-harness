import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executableFileName } from '@deepseek-ai/dsh-cli-account'
import type { ConnectorAccountRegistration } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import * as Feishu from '../src/index.ts'
import { COPY, FEISHU_PACKAGE, OPERATIONS, presentAccount } from '../src/presentation.ts'
import type { FeishuState } from '../src/types.ts'
import { createBinDir, ScriptedSubprocess } from './harness.ts'

const CONFIG = { commandTimeoutMs: 5_000 }
const ENTRY = fileURLToPath(new URL('../skills/feishu/SKILL.md', import.meta.url))

describe('Feishu plugin', () => {
  let ctx: Context
  let subprocess: ScriptedSubprocess
  let binDir: string
  let warnings: string[]

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ScriptedSubprocess)
    await ctx.plugin(SystemPrompt)
    subprocess = ctx.subprocess as ScriptedSubprocess
    binDir = await createBinDir()
    warnings = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(binDir, { recursive: true, force: true })
  })

  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

  it('lists the packaged feishu skill and loads its entry without running lark-cli', async () => {
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => `${skill.provider}/${skill.source}/${skill.name}`)).toEqual(['feishu/bundled/feishu'])
    expect(catalog[0]?.description).toContain('Load it before any Feishu or Lark task')

    const loaded = await ctx.skills.get('feishu')
    const file = await readFile(ENTRY, 'utf8')
    expect(loaded?.content.trim()).toBe(file.slice(file.indexOf('\n---\n', 4) + '\n---\n'.length).trim())
    expect(loaded?.content).toContain('# Feishu in DSH')
    expect(loaded?.content).toContain('open one with `lark-cli skills read <name>` in the Host Shell, not with the skill tool')
    expect(loaded?.resourceBase?.kind).toBe('directory')
    expect(loaded?.resourceBase?.kind === 'directory' ? loaded.resourceBase.path : '').toMatch(/[\\/]skills[\\/]feishu$/u)
    expect(subprocess.lookups).toEqual([])
    expect(subprocess.processes).toEqual([])
    expect(warnings).toEqual([])
  })

  it('withdraws the runtime context and the skill on disposal', async () => {
    const fiber = await ctx.plugin(Feishu, { ...CONFIG, binDir })
    expect(await runtimeContext()).toEqual([{
      name: 'feishu:cli',
      text: cliPathContextText({ name: 'feishu:cli', product: 'Feishu', program: 'lark-cli', executable: join(binDir, executableFileName('lark-cli')) }, process.platform),
    }])
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['feishu'])

    await fiber.dispose()

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
    expect(warnings).toEqual([])
  })

  it('shows the account on the Plugins page while the registry runs, and withdraws it with the plugin', async () => {
    const registered: ConnectorAccountRegistration<FeishuState>[] = []
    const withdrawn = vi.fn()
    ctx.provide('connectorAccounts', {
      register: (registration: ConnectorAccountRegistration<FeishuState>) => {
        registered.push(registration)
        return withdrawn
      },
    })
    const fiber = await ctx.plugin(Feishu, { ...CONFIG, binDir })
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ packageName: FEISHU_PACKAGE, operations: OPERATIONS, copy: COPY, present: presentAccount })
    expect(registered[0]!.source.snapshot().account.state).toBe('unchecked')

    await fiber.dispose()

    expect(withdrawn).toHaveBeenCalledOnce()
  })
})
