/** Embedded lark-cli skills adapted to the DSH Shell and the shared default account. */

import type { Context } from '@deepseek-ai/cordis'
import z from 'zod'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { CliCommandExecutor } from '@deepseek-ai/dsh-cli-account'
import { runJson } from './cli.ts'

const Catalog = z.object({
  ok: z.literal(true),
  skills: z.array(z.object({ name: z.string().refine(isSkillName), description: z.string().min(1) })),
})
const Skill = z.object({ skill: z.string(), path: z.string(), content: z.string(), guidance: z.string() })
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u

const GUIDANCE = [
  '# Feishu in DSH',
  'Call this integration the Feishu plugin (飞书插件 in Chinese) in user-facing replies. Run `lark-cli` by name in the Host Shell; DSH installs and updates it. It uses the default lark-cli configuration and sign-in shared with the user\'s own terminal, so do not remove, switch, or sign out of apps or profiles unless the user asks.',
  'When a command reports a missing app configuration or sign-in, first ask the user to connect Feishu on the Feishu plugin page in Plugins. Load the lark-shared skill and run its setup and auth flow yourself only when the user asks to finish it in this conversation. Never ask for or print app secrets or tokens.',
  'Commands that save sign-in state, such as `auth login --device-code` and `config init`, write outside the workspace and use up their one-time authorization even when the save is denied: run them with the Shell tool\'s single-command approval from the start. Run other commands in the existing sandbox and request that approval only when a credential, lock, log, or cache write is denied.',
  'Do not install another lark-cli or run `lark-cli update`.',
].join('\n\n')

/** Lists native embedded skills once per registration; provider disposal cancels outstanding CLI reads. */
export class FeishuSkillProvider implements SkillProvider {
  readonly name = 'feishu'
  private catalog: Promise<SkillCandidate[]> | undefined

  constructor(
    private readonly cli: CliCommandExecutor,
    private readonly control: SkillProviderControl,
    private readonly logger: Context['logger'],
  ) {}

  list(): Promise<SkillCandidate[]> {
    this.catalog ??= this.load().catch((error: unknown) => {
      if (!this.control.signal.aborted) this.logger.warn(`feishu: skills unavailable until the plugin reloads: ${String(error)}`)
      return []
    })
    return this.catalog
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition> {
    const signal = options.signal === undefined ? this.control.signal : AbortSignal.any([options.signal, this.control.signal])
    const parsed = Skill.safeParse(await runJson(this.cli, ['skills', 'read', candidate.name, '--json'], signal))
    const skill = parsed.data
    const frontmatter = skill === undefined ? null : FRONTMATTER.exec(skill.content)
    if (skill === undefined || skill.skill !== candidate.name || skill.path !== 'SKILL.md' || frontmatter === null) {
      throw new Error(`lark-cli skills read ${candidate.name} --json returned an unexpected skill document`, { cause: parsed.error })
    }
    const content = [GUIDANCE, skill.content.slice(frontmatter[0].length).trim(), skill.guidance.trim()].join('\n\n')
    const { rank: _rank, locator: _locator, ...summary } = candidate
    return { ...summary, content }
  }

  private async load(): Promise<SkillCandidate[]> {
    const catalog = Catalog.safeParse(await runJson(this.cli, ['skills', 'list', '--json'], this.control.signal))
    if (!catalog.success) throw new Error('lark-cli skills list --json returned an unexpected catalog', { cause: catalog.error })
    return catalog.data.skills.map(skill => ({
      ...skill,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: this.name,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      locator: skill.name,
      resourceBase: { kind: 'opaque', description: 'Embedded lark-cli references; use the skills read command given in the loaded skill.' },
    }))
  }
}
