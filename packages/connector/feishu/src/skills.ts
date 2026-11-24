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

/**
 * Lists the packaged entry while lark-cli is installed, without running it; the entry is read once, when the plugin
 * loads. The catalog caches a listing, so one made while lark-cli was missing lacks the entry until {@link relist}
 * invalidates it.
 */
export class FeishuSkillProvider implements SkillProvider {
  readonly name = 'feishu'
  private readonly candidate: SkillCandidate
  private readonly content: string
  /** Whether the catalog may hold a listing made while lark-cli was missing. */
  private unlisted = false

  /**
   * @param entry - absolute path of the packaged `SKILL.md`, whose frontmatter gives the skill's name and description.
   * @param installed - whether lark-cli, which serves the guides the entry indexes, is in place.
   * @param invalidate - makes the catalog list this provider again.
   * @throws when the entry has no YAML frontmatter, or its frontmatter has no skill name or no description.
   */
  constructor(entry: string, private readonly installed: () => boolean, private readonly invalidate: () => void) {
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
    if (this.installed()) return Promise.resolve([this.candidate])
    this.unlisted = true
    return Promise.resolve([])
  }

  /**
   * Invalidate the catalog once when lark-cli is in place and a listing was made without it. lark-cli can appear
   * without a download that this plugin finished: a cancelled or failed install script may already have copied it, and
   * the user can run that script in a terminal. The plugin calls this after each download attempt and before each
   * account operation.
   */
  relist(): void {
    if (!this.unlisted || !this.installed()) return
    this.unlisted = false
    this.invalidate()
  }

  get(): Promise<SkillDefinition> {
    const { rank: _rank, locator: _locator, ...summary } = this.candidate
    return Promise.resolve({ ...summary, content: this.content })
  }
}
