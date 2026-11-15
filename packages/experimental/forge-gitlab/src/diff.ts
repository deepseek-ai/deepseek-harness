/** Merge request patches pinned to one head through MR diff versions, and comparisons of two commits. */

import type { ChangeRequestRef, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { structuredPatch } from 'diff'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { checkedProject, mergeRequestPath } from './urls.ts'

/** A full SHA-1 or SHA-256 object name. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * Check a commit object name before it is inlined into a request.
 * @param value - candidate object name.
 * @returns whether it is a full 40- or 64-digit hexadecimal commit.
 */
export function isCommit(value: string): boolean {
  return COMMIT.test(value)
}

const versionSchema = z.object({
  id: z.number(),
  head_commit_sha: z.string(),
  base_commit_sha: z.string(),
  start_commit_sha: z.string(),
  real_size: z.string().nullable().optional(),
})

const fileSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  a_mode: z.string().nullable(),
  b_mode: z.string().nullable(),
  new_file: z.boolean(),
  renamed_file: z.boolean(),
  deleted_file: z.boolean(),
  diff: z.string(),
  collapsed: z.boolean().optional(),
  too_large: z.boolean().optional(),
})

/** One MR diff version: the head, merge base, and target tip GitLab recorded for one push. */
export type DiffVersion = z.infer<typeof versionSchema>

/** One changed file as GitLab lists it. */
type DiffFileNode = z.infer<typeof fileSchema>

/** Reads the text of a file at a commit, for files whose diff GitLab left out. */
export type ReadText = (commit: string, path: string) => Promise<string | ForgeFailure>

/**
 * Find the newest diff version of a merge request and check that it is at `headSha`. GitLab records a version for
 * every push, so the newest version's head is the merge request's head once GitLab has processed the push.
 * @param api - GitLab reads.
 * @param ref - merge request.
 * @param headSha - head commit the caller expects.
 * @param signal - cancellation of the read.
 * @returns the version, `stale` when the newest version is at another head, or the read's failure.
 */
export async function newestVersion(
  api: GitLabApi, ref: ChangeRequestRef, headSha: string, signal: AbortSignal,
): Promise<DiffVersion | ForgeFailure> {
  const read = await api.rest(ref.repository.host, `${mergeRequestPath(ref)}/versions?per_page=1`, signal)
  if (!read.ok) return read.failure
  const parsed = z.array(versionSchema).safeParse(read.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitLab response to the diff version listing' }
  const newest = parsed.data[0]
  if (newest === undefined) return { code: 'stale', message: `merge request ${ref.number} has no diff version yet` }
  if (newest.head_commit_sha.toLowerCase() !== headSha.toLowerCase()) {
    return { code: 'stale', message: `the merge request head moved from ${headSha} to ${newest.head_commit_sha}` }
  }
  return newest
}

/**
 * Read the patch of one diff version, the changes from its merge base to its head.
 * @param api - GitLab reads.
 * @param ref - merge request.
 * @param version - the version.
 * @param readText - reads a file whose diff GitLab collapsed.
 * @param signal - cancellation of the read.
 * @returns the unified patch with `a/` and `b/` prefixes, or why it could not be read; a version over GitLab's file
 * limit, whose `real_size` ends in `+`, is `too-large`.
 */
export async function versionPatch(
  api: GitLabApi, ref: ChangeRequestRef, version: DiffVersion, readText: ReadText, signal: AbortSignal,
): Promise<string | ForgeFailure> {
  if (version.real_size?.endsWith('+') === true) return { code: 'too-large', message: `merge request ${ref.number} changes more files than GitLab lists` }
  const read = await api.rest(ref.repository.host, `${mergeRequestPath(ref)}/versions/${version.id}?unidiff=true`, signal)
  if (!read.ok) return read.failure
  const parsed = z.object({ diffs: z.array(fileSchema) }).safeParse(read.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitLab response to the diff version' }
  return await assemble(parsed.data.diffs, version.base_commit_sha, version.head_commit_sha, readText)
}

/**
 * Read the changes from commit `base` to commit `head` in the merge request's project.
 * @param api - GitLab reads.
 * @param ref - merge request whose project holds both commits.
 * @param base - full object name of the older commit.
 * @param head - full object name of the newer commit.
 * @param readText - reads a file whose diff GitLab collapsed.
 * @param signal - cancellation of the read.
 * @returns the unified patch, or why it could not be read; a comparison GitLab stopped for time is `too-large`.
 */
export async function comparePatch(
  api: GitLabApi, ref: ChangeRequestRef, base: string, head: string, readText: ReadText, signal: AbortSignal,
): Promise<string | ForgeFailure> {
  const project = encodeURIComponent(checkedProject(ref))
  const read = await api.rest(ref.repository.host, `projects/${project}/repository/compare?from=${base}&to=${head}&unidiff=true`, signal)
  if (!read.ok) return read.failure
  const parsed = z.object({ diffs: z.array(fileSchema), compare_timeout: z.boolean().optional() }).safeParse(read.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitLab response to the comparison' }
  if (parsed.data.compare_timeout === true) return { code: 'too-large', message: `GitLab stopped comparing ${base} with ${head}` }
  return await assemble(parsed.data.diffs, base, head, readText)
}

/** One changed file of a diff version with its diff, which GitLab's own diff or a comparison of its texts supplies. */
export interface VersionFileDiff {
  readonly oldPath: string
  readonly newPath: string
  /** Unified diff of the file, with `---` and `+++` lines when it was compared from the texts. */
  readonly diff: string
}

/**
 * Read the changed files of one diff version with the diff of each, comparing a file GitLab collapsed or found too large
 * from its texts at the version's merge base and head.
 * @param api - GitLab reads.
 * @param ref - merge request.
 * @param version - id of the diff version.
 * @param readText - reads a file whose diff GitLab collapsed.
 * @param signal - cancellation of the read.
 * @returns the files in GitLab's order, or undefined when GitLab did not list them or a file's text could not be read.
 */
export async function versionFileDiffs(
  api: GitLabApi, ref: ChangeRequestRef, version: number, readText: ReadText, signal: AbortSignal,
): Promise<VersionFileDiff[] | undefined> {
  const read = await api.rest(ref.repository.host, `${mergeRequestPath(ref)}/versions/${version}?unidiff=true`, signal)
  const parsed = read.ok
    ? z.object({ base_commit_sha: z.string(), head_commit_sha: z.string(), diffs: z.array(fileSchema) }).safeParse(read.body)
    : undefined
  if (parsed?.success !== true) return undefined
  const files: VersionFileDiff[] = []
  for (const file of parsed.data.diffs) {
    const diff = await fileDiff(file, parsed.data.base_commit_sha, parsed.data.head_commit_sha, readText)
    if (typeof diff !== 'string') return undefined
    files.push({ oldPath: file.old_path, newPath: file.new_path, diff })
  }
  return files
}

/**
 * Join GitLab's per-file diffs into one unified patch with Git's headers, ordered by path as GitLab's raw patch is. A
 * file whose diff GitLab collapsed or found too large, which it returns empty, is compared here from its text at both
 * commits.
 * @param files - changed files in GitLab's order.
 * @param base - commit of the old sides.
 * @param head - commit of the new sides.
 * @param readText - reads a file at a commit.
 * @returns the patch, or the failure of a file read.
 */
async function assemble(files: readonly DiffFileNode[], base: string, head: string, readText: ReadText): Promise<string | ForgeFailure> {
  const parts: string[] = []
  // GitLab lists a version's files in its own order; its raw patch, like Git's, orders them by path.
  const ordered = [...files].sort((left, right) => compareText(`${left.old_path}\0${left.new_path}`, `${right.old_path}\0${right.new_path}`))
  for (const file of ordered) {
    const header = [`diff --git a/${file.old_path} b/${file.new_path}`]
    if (file.new_file) header.push(`new file mode ${file.b_mode ?? '100644'}`)
    else if (file.deleted_file) header.push(`deleted file mode ${file.a_mode ?? '100644'}`)
    else if (file.a_mode !== null && file.b_mode !== null && file.a_mode !== file.b_mode) header.push(`old mode ${file.a_mode}`, `new mode ${file.b_mode}`)
    if (file.renamed_file) header.push(`rename from ${file.old_path}`, `rename to ${file.new_path}`)
    const body = await fileDiff(file, base, head, readText)
    if (typeof body !== 'string') return body
    parts.push(`${header.join('\n')}\n${body === '' || body.endsWith('\n') ? body : `${body}\n`}`)
  }
  return parts.join('')
}

/** GitLab's diff of one file, or for a file it collapsed or found too large, which it returns empty, a comparison of its texts. */
async function fileDiff(file: DiffFileNode, base: string, head: string, readText: ReadText): Promise<string | ForgeFailure> {
  return file.diff === '' && (file.collapsed === true || file.too_large === true) ? await compareTexts(file, base, head, readText) : file.diff
}

/** Order two strings by their UTF-16 code units, as `<` does, for a sort comparator. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Compare one file's text at both commits as the `---`, `+++`, and hunk lines of a patch. */
async function compareTexts(file: DiffFileNode, base: string, head: string, readText: ReadText): Promise<string | ForgeFailure> {
  const before = file.new_file ? '' : await readText(base, file.old_path)
  if (typeof before !== 'string') return before
  const after = file.deleted_file ? '' : await readText(head, file.new_path)
  if (typeof after !== 'string') return after
  const oldName = file.new_file ? '/dev/null' : `a/${file.old_path}`
  const newName = file.deleted_file ? '/dev/null' : `b/${file.new_path}`
  if (before.includes('\0') || after.includes('\0')) return `Binary files ${oldName} and ${newName} differ\n`
  return textPatch(oldName, newName, before, after)
}

/**
 * Compare two texts as the `---`, `+++`, and hunk lines of a patch with three lines of context.
 * @param oldName - old side's name, such as `a/<path>` or `/dev/null`.
 * @param newName - new side's name.
 * @param before - old text.
 * @param after - new text.
 * @returns the patch lines, ending with a newline.
 */
export function textPatch(oldName: string, newName: string, before: string, after: string): string {
  const patch = structuredPatch(oldName, newName, before, after, '', '', { context: 3 })
  // Git numbers an empty side from the line before it, so an added or deleted file's empty side starts at 0.
  const start = (line: number, count: number): number => count === 0 ? line - 1 : line
  const hunks = patch.hunks.map(hunk =>
    `@@ -${start(hunk.oldStart, hunk.oldLines)},${hunk.oldLines} +${start(hunk.newStart, hunk.newLines)},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`)
  return `--- ${oldName}\n+++ ${newName}\n${hunks.join('')}`
}

/**
 * Read the merge base of two commits in the merge request's project.
 * @param api - GitLab reads.
 * @param ref - merge request whose project holds both commits.
 * @param base - full object name of one commit.
 * @param head - full object name of the other.
 * @param signal - cancellation of the read.
 * @returns the merge base's full object name, or why GitLab did not name one.
 */
export async function mergeBaseOf(
  api: GitLabApi, ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal,
): Promise<string | ForgeFailure> {
  const project = encodeURIComponent(checkedProject(ref))
  const read = await api.rest(ref.repository.host, `projects/${project}/repository/merge_base?refs[]=${base}&refs[]=${head}`, signal)
  if (!read.ok) return read.failure
  const parsed = z.object({ id: z.string() }).safeParse(read.body)
  return parsed.success && isCommit(parsed.data.id) ? parsed.data.id
    : { code: 'unavailable', message: 'GitLab named no full merge base commit' }
}

/**
 * Read the text of a file at a commit.
 * @param api - GitLab reads.
 * @param ref - merge request whose project holds the file.
 * @param commit - full object name of the commit.
 * @param path - repository-relative path.
 * @param signal - cancellation of the read.
 * @returns the text, or why GitLab did not return it.
 */
export async function fileTextOf(
  api: GitLabApi, ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal,
): Promise<string | ForgeFailure> {
  const project = encodeURIComponent(checkedProject(ref))
  return await api.restText(ref.repository.host, `projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${commit}`, signal)
}
