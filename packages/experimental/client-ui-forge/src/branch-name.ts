/** Branch-name rules and branch labels shared by the Host and the Client; free of Node imports. */

/** Prefix of the full names of local branches. */
export const LOCAL_REF_PREFIX = 'refs/heads/'

/** Prefix of the full names of remote-tracking branches. */
export const REMOTE_REF_PREFIX = 'refs/remotes/'

/**
 * Why a name cannot be a new branch name: Git's rules for `refs/heads/<name>`, plus the worktree service's
 * refusal of a leading `-`.
 */
export type BranchNameProblem =
  | 'empty'
  | 'space'
  | 'character'
  | 'leading-dash'
  | 'leading-slash'
  | 'trailing-slash'
  | 'double-slash'
  | 'double-dot'
  | 'trailing-dot'
  | 'at'
  | 'at-brace'
  | 'dot-segment'
  | 'lock-segment'

/** Characters Git refuses anywhere in a ref name: ASCII controls, `~ ^ : ? * [`, and the backslash. */
const FORBIDDEN = /[\u0000-\u001f\u007f~^:?*[\\]/

/**
 * Find the first rule a new branch name breaks. `git check-ref-format` stays the final check on the Host.
 * @param name - candidate branch name.
 * @returns the broken rule, or null when the name passes every rule.
 */
export function branchNameProblem(name: string): BranchNameProblem | null {
  if (name.length === 0) return 'empty'
  if (/\s/.test(name)) return 'space'
  if (FORBIDDEN.test(name)) return 'character'
  if (name.startsWith('-')) return 'leading-dash'
  if (name.startsWith('/')) return 'leading-slash'
  if (name.endsWith('/')) return 'trailing-slash'
  if (name.includes('//')) return 'double-slash'
  if (name.includes('..')) return 'double-dot'
  if (name.endsWith('.')) return 'trailing-dot'
  if (name === '@') return 'at'
  if (name.includes('@{')) return 'at-brace'
  const segments = name.split('/')
  if (segments.some(segment => segment.startsWith('.'))) return 'dot-segment'
  if (segments.some(segment => segment.endsWith('.lock'))) return 'lock-segment'
  return null
}

/**
 * The name a branch shows: a full local or remote-tracking branch name without its `refs/heads/` or
 * `refs/remotes/` prefix; any other revision, such as a short name an earlier panel recorded, as it is.
 * @param ref - branch or revision.
 * @returns the shown name.
 */
export function branchLabel(ref: string): string {
  for (const prefix of [LOCAL_REF_PREFIX, REMOTE_REF_PREFIX]) {
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length)
  }
  return ref
}

/**
 * Whether a revision is the full name of a remote-tracking branch, which a worktree creation fetches first.
 * @param ref - branch or revision, or null for HEAD.
 * @returns whether `ref` lies under `refs/remotes/`.
 */
export function isRemoteRef(ref: string | null): boolean {
  return ref !== null && ref.startsWith(REMOTE_REF_PREFIX) && ref.length > REMOTE_REF_PREFIX.length
}
