/**
 * Record a production release in git after it reaches the download domain.
 *
 * A build that only goes to a colleague or a test feed carries its commit
 * inside the artifact, which is enough to trace it. A build that external users
 * install should also be reachable from the repository, so a production upload
 * tags the commit it was packaged from. The tag is written after the upload
 * succeeds: a tag for a release that never shipped would be worse than none.
 *
 * Tagging never fails an upload that already completed. The artifacts are
 * public by then, and nothing about a missing tag can be repaired by reporting
 * the upload as failed; the operator is told what to run instead.
 */

import { execFileSync } from 'node:child_process'

/** What tagging one uploaded release did, or why it did nothing. */
export interface DesktopReleaseTagResult {
  readonly tag: string
  readonly status: 'created' | 'present' | 'failed'
  /** Commands that finish the tagging a failure interrupted, in order. */
  readonly recovery?: readonly string[]
  readonly detail?: string
}

/**
 * Name the tag one published version carries.
 * @param version - Version the release published.
 * @returns The tag name, distinct from the `dsh-v*` tags the npm family publishes from.
 */
export function desktopReleaseTag(version: string): string {
  return `desktop-v${version}`
}

/**
 * Tag and push the commit a production release was packaged from.
 * @param options - Published version, packaged commit, repository, and remote.
 * @returns What tagging did; a failure is reported rather than thrown.
 */
export function tagDesktopRelease(options: {
  readonly version: string
  readonly commit: string
  readonly repositoryRoot: string
  readonly remote?: string
  readonly run?: (command: string, args: readonly string[]) => string
}): DesktopReleaseTagResult {
  const tag = desktopReleaseTag(options.version)
  const remote = options.remote ?? 'origin'
  const run = options.run
    ?? ((command: string, args: readonly string[]) =>
      execFileSync(command, [...args], { cwd: options.repositoryRoot, encoding: 'utf8' }).trim())
  const create = `git tag ${tag} ${options.commit}`
  const push = `git push ${remote} ${tag}`
  // A local tag that already exists makes `git tag` fail, so recovery must name only the steps still outstanding.
  let tagged = false
  try {
    const existing = run('git', ['tag', '--list', tag])
    if (existing !== '') {
      const named = run('git', ['rev-list', '-n', '1', tag])
      if (named !== options.commit) {
        return { tag, status: 'failed', detail: `${tag} already names ${named}, not the uploaded commit ${options.commit}` }
      }
      tagged = true
      run('git', ['push', remote, tag])
      return { tag, status: 'present' }
    }
    run('git', ['tag', tag, options.commit])
    tagged = true
    run('git', ['push', remote, tag])
    return { tag, status: 'created' }
  }
  catch (error) {
    return {
      tag,
      status: 'failed',
      recovery: tagged ? [push] : [create, push],
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
