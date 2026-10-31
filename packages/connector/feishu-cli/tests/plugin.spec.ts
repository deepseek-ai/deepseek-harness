import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executableFileName } from '@deepseek-ai/dsh-cli-account'
import type { CliAccountRegistration } from '@deepseek-ai/dsh-cli-account/types'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import * as Feishu from '../src/index.ts'
import { COPY, FEISHU_PACKAGE, OPERATIONS, presentAccount } from '../src/presentation.ts'
import type { FeishuState } from '../src/types.ts'
import { byArguments, CATALOG, createBinDir, ScriptedSubprocess } from './harness.ts'

const CONFIG = { commandTimeoutMs: 5_000 }
const LIST = 'skills list --json'
const RELEASE_CATALOG = new URL('./fixtures/lark-cli-1.0.97-skills.json', import.meta.url)

/**
 * `packages/bundle/web-app/presets/standard.patch.yml` prunes a tool result only above `thresholdChars: 8192`
 * code points; a skill result below it reaches the model intact.
 */
const PRUNER_THRESHOLD_CHARS = 8192

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

  const load = async (): Promise<string> => (await ctx.skills.get('feishu'))?.content ?? ''
  const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())

  it('lists one feishu skill without running lark-cli', async () => {
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    expect(await ctx.skills.list()).toEqual([{
      name: 'feishu',
      description: expect.stringContaining('Load it before any Feishu or Lark task') as string,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'feishu',
      source: 'bundled',
      resourceBase: { kind: 'opaque', description: 'Embedded lark-cli guides; open them with the skills read command given in the loaded skill.' },
    }])
    expect(subprocess.processes).toEqual([])
  })

  it('loads the DSH guidance, an index of every guide, and how to open a guide', async () => {
    subprocess.respond = byArguments({ [LIST]: { stdout: JSON.stringify(CATALOG) } })
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    const content = await load()
    const sections = content.split('\n\n')
    const guides = sections.indexOf('## Guides')
    expect(sections[0]).toBe('# Feishu in DSH')
    expect(sections[guides + 1]).toBe('- `lark-doc`: Feishu documents\n- `lark-shared`: Setup and sign-in')
    expect(sections.indexOf('## Opening a guide')).toBeGreaterThan(guides)
    expect(content).toContain('open one with `lark-cli skills read <name>` in the Host Shell, not with the skill tool')
    expect(content).toContain('without the leading `../`: `lark-cli skills read lark-foo/...`')
    expect(subprocess.lookups.map(lookup => lookup.command)).toEqual([join(binDir, executableFileName('lark-cli'))])
  })

  it('renders the lark-cli 1.0.97 guide index below the tool-result pruning threshold', async () => {
    const stdout = await readFile(RELEASE_CATALOG, 'utf8')
    const release = JSON.parse(stdout) as typeof CATALOG
    subprocess.respond = byArguments({ [LIST]: { stdout } })
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    const loaded = await ctx.skills.get('feishu')
    if (loaded === undefined) throw new Error('the feishu skill did not load')
    for (const { name } of release.skills) expect(loaded.content).toContain(`- \`${name}\`: `)
    // The skill tool returns this rendering; its UTF-16 length is at least the code-point count the pruner measures.
    expect(renderSkillContent(loaded).length).toBeLessThan(PRUNER_THRESHOLD_CHARS)
  })

  it('fails a load whose catalog read fails and reads the catalog again on the next load', async () => {
    let reads = 0
    subprocess.respond = (process) => {
      reads += 1
      process.reply(reads === 1 ? { exitCode: 1, stderr: 'broken install' } : { stdout: JSON.stringify(CATALOG) })
    }
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    await expect(load()).rejects.toThrow('lark-cli skills list --json exited with 1: broken install')
    expect(await load()).toContain('- `lark-doc`: Feishu documents')
  })

  it('names the catalog command when its JSON does not match the catalog format', async () => {
    subprocess.respond = byArguments({ [LIST]: { stdout: JSON.stringify({ ok: true, skills: [{ name: 'Not A Skill', description: 'x' }] }) } })
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    await expect(load()).rejects.toThrow('lark-cli skills list --json returned an unexpected catalog')
  })

  it('terminates the catalog read when the lookup is cancelled', async () => {
    const lookup = new AbortController()
    subprocess.respond = () => { lookup.abort(new Error('lookup cancelled')) }
    await ctx.plugin(Feishu, { ...CONFIG, binDir })

    await expect(ctx.skills.get('feishu', { signal: lookup.signal })).rejects.toThrow('lookup cancelled')
    await vi.waitFor(() => { expect(subprocess.processes[0]?.terminated).toBe(true) })
  })

  it('withdraws the runtime context and the skill on disposal after owned processes exit, without a warning', async () => {
    subprocess.respond = (process) => { process.holdExit = true }
    const fiber = await ctx.plugin(Feishu, { ...CONFIG, binDir })
    expect(await runtimeContext()).toEqual([{
      name: 'feishu:cli',
      text: cliPathContextText({ name: 'feishu:cli', product: 'Feishu', program: 'lark-cli', executable: join(binDir, executableFileName('lark-cli')) }, process.platform),
    }])
    const loading = expect(load()).rejects.toThrow()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })

    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(subprocess.processes[0]?.terminated).toBe(true) })
    expect(disposed).toBe(false)
    subprocess.processes[0]?.release()
    await disposal
    await loading

    expect(await runtimeContext()).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
    expect(warnings).toEqual([])
  })

  it('shows the account on the Plugins page while the registry runs, and withdraws it with the plugin', async () => {
    const registered: CliAccountRegistration<FeishuState>[] = []
    const withdrawn = vi.fn()
    ctx.provide('cliAccounts', {
      register: (registration: CliAccountRegistration<FeishuState>) => {
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
