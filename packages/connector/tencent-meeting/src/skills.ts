/** The packaged `tencent-meeting` entry skill and the upstream guide it indexes. */

import { fileURLToPath } from 'node:url'
import type { UpstreamSkillSet } from '@deepseek-ai/dsh-upstream-skills'

/** The packaged entry, which opens the guide by its repository path `skills/tmeet-skill/SKILL.md`. */
export const ENTRY = fileURLToPath(new URL('../skills/tencent-meeting/SKILL.md', import.meta.url))

/**
 * The official tmeet guide at the release the plugin installs, without `scripts/agent_init.py`, which the entry tells the
 * agent to skip because DSH runs `tmeet` by its absolute path.
 */
export const TMEET_SKILLS: UpstreamSkillSet = {
  repository: 'TencentCloud/tencentmeeting-cli',
  commit: 'e631b355da2b001d24b82f453b65d96f39c59865',
  directory: 'skills/tmeet-skill',
  exclude: ['skills/tmeet-skill/scripts/agent_init.py'],
  license: 'LICENSE',
  bytes: 181_429,
  sha256: '9bbdf81af17a49e1610063acd2a29f274313411e64a91e028588e3feb55bb7db',
}
