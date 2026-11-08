/**
 * Print the pinned upstream skill set of a GitHub commit for a plugin's constant: download the commit archive, keep the
 * selected files the way `@deepseek-ai/dsh-upstream-skills` keeps them, and report their total size, digest, and
 * `SKILL.md` paths. Run it with `pnpm exec tsx scripts/upstream-skills-digest.ts --repository <owner>/<repository>
 * --commit <full id> --directory <path> [--exclude <path>]... [--license LICENSE] [--url <prefix>]`; `--url` defaults to
 * `https://codeload.github.com`.
 */

import { parseArgs } from 'node:util'
import { archiveUrl, digestFiles, fetchArchive } from '../packages/connector/upstream-skills/src/archive.ts'
import type { UpstreamSkillSelection, UpstreamSkillSet } from '../packages/connector/upstream-skills/src/types.ts'

/** The most bytes the kept files may hold here, where no pin bounds them yet. */
const MAX_BYTES = 64 * 1024 * 1024
/** How long the download may take. */
const TIMEOUT_MS = 120_000

/**
 * Download and pin one selection.
 * @param selection - the repository, commit, kept directory, exclusions, and license file.
 * @param base - the archive download prefix.
 * @returns the pinned set and the kept `SKILL.md` paths.
 */
export async function pinSkillSet(selection: UpstreamSkillSelection, base: string): Promise<{ set: UpstreamSkillSet; skills: string[] }> {
  const files = await fetchArchive(archiveUrl(base, selection), selection, MAX_BYTES, AbortSignal.timeout(TIMEOUT_MS))
  const bytes = [...files.values()].reduce((total, content) => total + content.length, 0)
  const skills = [...files.keys()].filter(path => path.endsWith('/SKILL.md')).toSorted()
  return { set: { ...selection, bytes, sha256: digestFiles(files) }, skills }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      commit: { type: 'string' },
      directory: { type: 'string' },
      exclude: { type: 'string', multiple: true, default: [] },
      license: { type: 'string', default: 'LICENSE' },
      url: { type: 'string', default: 'https://codeload.github.com' },
    },
  })
  const { repository, commit, directory, exclude, license, url } = values
  if (repository === undefined || commit === undefined || !/^[0-9a-f]{40}$/u.test(commit) || directory === undefined) {
    throw new Error('pass --repository <owner>/<repository>, --commit <full commit id>, and --directory <path>')
  }
  const { set, skills } = await pinSkillSet({ repository, commit, directory: directory.replace(/\/+$/u, ''), exclude, license }, url)
  console.log(JSON.stringify(set, undefined, 2))
  console.error(`${String(skills.length)} SKILL.md files:\n${skills.join('\n')}`)
}
