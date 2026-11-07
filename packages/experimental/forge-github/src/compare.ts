/** Reads GitHub's patch between two commits through the REST compare endpoint. */

import type { ForgeFailure, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'
import { isCommit } from './urls.ts'

/** Runs one reading `gh` command and maps a refusal to a failure, as the provider's reads do. */
export type GhTextReader = (args: readonly string[], signal: AbortSignal) => Promise<string | ForgeFailure>

/** `gh` option that prints a response containing terminal escape sequences; `gh` 2.97 added it. */
const ALLOW_ESCAPES = '--allow-escape-sequences'

/** What a `gh` older than 2.97 reports for {@link ALLOW_ESCAPES}, before it sends any request. */
const UNKNOWN_ALLOW_ESCAPES = `unknown flag: ${ALLOW_ESCAPES}`

/**
 * Read the unified patch from the merge base of `base` and `head` to `head`, as
 * GitHub computes the diff of a pull request with that base and head commit.
 * Both ends are commit object names, so the answer never follows a moving
 * branch. The patch keeps terminal escape sequences that file contents hold:
 * `gh` 2.97 and newer refuses to print them without `--allow-escape-sequences`,
 * and an older `gh`, which rejects that option, prints them unchanged, so a
 * rejection of the option alone repeats the read without it.
 * GitHub returns the patch however many files it changes; `read` bounds its size.
 * @param read - runs `gh` with the provider's output limit and failure mapping.
 * @param repository - repository that holds both commits, with an owner and name already checked for inlining.
 * @param base - commit whose merge base with `head` starts the patch.
 * @param head - commit the patch ends at.
 * @param signal - cancellation of the read.
 * @returns the patch with `a/` and `b/` path prefixes, or why GitHub did not provide it.
 * @throws when `base` or `head` is not a full commit object name.
 */
export async function readComparison(
  read: GhTextReader, repository: ForgeRepository, base: string, head: string, signal: AbortSignal,
): Promise<string | ForgeFailure> {
  for (const commit of [base, head]) {
    if (!isCommit(commit)) throw new Error(`forge-github: invalid commit ${JSON.stringify(commit)}`)
  }
  const { host, owner, name } = repository
  const request = ['-H', 'Accept: application/vnd.github.diff', `repos/${owner}/${name}/compare/${base}...${head}`]
  const patch = await read(['api', '--hostname', host, ALLOW_ESCAPES, ...request], signal)
  if (typeof patch === 'string' || !patch.message.startsWith(UNKNOWN_ALLOW_ESCAPES)) return patch
  return await read(['api', '--hostname', host, ...request], signal)
}
