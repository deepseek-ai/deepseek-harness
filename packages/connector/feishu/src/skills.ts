/** The packaged `feishu` entry skill: the DSH guidance, the index of the guides embedded in lark-cli, and how to open them. */

import { readFileSync } from 'node:fs'
import z from 'zod'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

const Frontmatter = z.object({ name: z.string().refine(isSkillName), description: z.string().min(1) })
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u
/** The guides are not files: the loaded entry tells the model to open them through lark-cli. */
const RESOURCES = 'Embedded lark-cli guides; open them with the skills read command given in the loaded skill.'

/** Lists the packaged entry without running lark-cli; the entry is read once, when the plugin loads. */
export class FeishuSkillProvider implements SkillProvider {
  readonly name = 'feishu'
  private readonly candidate: SkillCandidate
  private readonly content: string

  /**
   * @param entry - absolute path of the packaged `SKILL.md`, whose frontmatter gives the skill's name and description.
   * @throws when the entry has no YAML frontmatter, or its frontmatter has no skill name or no description.
   */
  constructor(entry: string) {
    const raw = readFileSync(entry, 'utf8')
    const match = FRONTMATTER.exec(raw)
    const block = match?.[1]
    if (match === null || block === undefined) throw new Error(`feishu: ${entry} has no YAML frontmatter`)
    const parsed = Frontmatter.safeParse(parseYaml(block))
    if (!parsed.success) throw new Error(`feishu: ${entry} needs a skill name and a description in its frontmatter`, { cause: parsed.error })
    this.content = raw.slice(match[0].length).trim()
    this.candidate = {
      ...parsed.data,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: this.name,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      locator: entry,
      resourceBase: { kind: 'opaque', description: RESOURCES },
    }
  }

  list(): Promise<SkillCandidate[]> {
    return Promise.resolve([this.candidate])
  }

  get(): Promise<SkillDefinition> {
    const { rank: _rank, locator: _locator, ...summary } = this.candidate
    return Promise.resolve({ ...summary, content: this.content })
  }
}
