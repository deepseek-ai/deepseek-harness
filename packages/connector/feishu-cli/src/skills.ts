/** One Feishu skill that indexes the embedded lark-cli guides for the DSH Shell and the shared default account. */

import z from 'zod'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { CliCommandExecutor } from '@deepseek-ai/dsh-cli-account'
import { runJson } from './cli.ts'

const Catalog = z.object({
  ok: z.literal(true),
  skills: z.array(z.object({ name: z.string().refine(isSkillName), description: z.string().min(1) })),
})

const GUIDANCE = [
  '# Feishu in DSH',
  'Call this integration the Feishu plugin (飞书插件 in Chinese) in user-facing replies. Run `lark-cli` by name in the Host Shell; DSH installs the version this plugin pins. It uses the default lark-cli configuration and sign-in shared with the user\'s own terminal, so do not remove, switch, or sign out of apps or profiles unless the user asks.',
  'When a command reports a missing app configuration or sign-in, first ask the user to connect Feishu on the Feishu plugin page in Plugins. Open the lark-shared guide and run its setup and auth flow yourself only when the user asks to finish it in this conversation. Never ask for or print app secrets or tokens.',
  'Commands that save sign-in state, such as `auth login --device-code` and `config init`, write outside the workspace and use up their one-time authorization even when the save is denied: on the first attempt, set the Shell tool\'s `sandbox_permissions` to the narrowest mode that can write outside the workspace, with a `justification`. Run other commands in the existing sandbox and set `sandbox_permissions` only when a credential, lock, log, or cache write is denied.',
  'Do not install another lark-cli or run `lark-cli update`.',
].join('\n\n')

const OPENING = [
  '## Opening a guide',
  'These guides belong to lark-cli and are not skills: open one with `lark-cli skills read <name>` in the Host Shell, not with the skill tool.',
  'Read a file that a guide references, such as `references/...`, with `lark-cli skills read <name> <relative-path>`. Read a reference to another guide, such as `../lark-foo/...`, with the same command without the leading `../`: `lark-cli skills read lark-foo/...`.',
].join('\n\n')

/** Lists the one `feishu` skill without running lark-cli; each load reads the CLI's current guide catalog. */
export class FeishuSkillProvider implements SkillProvider {
  readonly name = 'feishu'

  constructor(
    private readonly cli: CliCommandExecutor,
    private readonly control: SkillProviderControl,
  ) {}

  list(): Promise<SkillCandidate[]> {
    return Promise.resolve([{
      name: 'feishu',
      description: 'Feishu (飞书) and Lark through the bundled lark-cli: documents and wiki, Base, sheets, slides, Drive files, messages and group chats, calendar, video meetings and minutes, tasks, approvals, mail, contacts, OKR, attendance, events, and the CLI\'s app setup and sign-in. Load it before any Feishu or Lark task; it indexes the guides and how to open them.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: this.name,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      locator: 'feishu',
      resourceBase: { kind: 'opaque', description: 'Embedded lark-cli guides; open them with the skills read command given in the loaded skill.' },
    }])
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition> {
    const signal = options.signal === undefined ? this.control.signal : AbortSignal.any([options.signal, this.control.signal])
    const catalog = Catalog.safeParse(await runJson(this.cli, ['skills', 'list', '--json'], signal))
    if (!catalog.success) throw new Error('lark-cli skills list --json returned an unexpected catalog', { cause: catalog.error })
    const index = ['## Guides', catalog.data.skills.map(skill => `- \`${skill.name}\`: ${skill.description}`).join('\n')].join('\n\n')
    const { rank: _rank, locator: _locator, ...summary } = candidate
    return { ...summary, content: [GUIDANCE, index, OPENING].join('\n\n') }
  }
}
