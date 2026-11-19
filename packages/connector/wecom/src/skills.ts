/** The packaged `wecom` entry skill and the upstream guides it indexes. */

import { fileURLToPath } from 'node:url'
import type { UpstreamSkillSet } from '@deepseek-ai/dsh-upstream-skills'

/** The packaged entry, whose index names each guide by its repository path `skills/<guide>/SKILL.md`. */
export const ENTRY = fileURLToPath(new URL('../skills/wecom/SKILL.md', import.meta.url))

/** Every skill of the official WeCom CLI repository, at the commit the entry's index and guidance were verified with. */
export const WECOM_SKILLS: UpstreamSkillSet = {
  repository: 'WecomTeam/wecom-cli',
  commit: '4c74ff28838d8fba267eaab5179d9d56f9ca61ae',
  directory: 'skills',
  exclude: [],
  license: 'LICENSE',
  bytes: 1_754_686,
  sha256: 'c75045cc5297d5886c8a7ff01c993a782e50cbd4aa6f6559394b695157d52e10',
}
