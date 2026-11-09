/**
 * Checks of a chosen run of commits against a commit list, shared by the Host, which reads the run's changes, and the
 * commit picker, which refuses a run before asking for them.
 */

import type { ForgeCommit } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeCommitRange } from './types.ts'

/**
 * Find the first commit of a chosen run in a commit list. Two ends describe the run only when each commit after the
 * first has the commit listed before it as its first parent, so the changes from the first commit's first parent to the
 * last commit are exactly the run's changes.
 * @param commits - listed commits, oldest first.
 * @param range - the chosen run.
 * @returns the first chosen commit; `missing` when an end is not listed or `to` is listed before `from`; `not-linear`
 * when a commit of the run does not have the commit listed before it as its first parent.
 */
export function rangeStart(commits: readonly ForgeCommit[], range: ForgeCommitRange): ForgeCommit | 'missing' | 'not-linear' {
  const first = commits.findIndex(commit => commit.sha === range.from)
  const last = commits.findIndex(commit => commit.sha === range.to)
  const start = commits[first]
  if (start === undefined || last < first) return 'missing'
  for (let index = first + 1; index <= last; index++) {
    if (commits[index]?.parent !== commits[index - 1]?.sha) return 'not-linear'
  }
  return start
}
