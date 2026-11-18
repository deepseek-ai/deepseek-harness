/** Parsers for the porcelain output of the read-only Git commands the panel runs. */

import type { ForgeBaseBranch, ForgeRemoteDefault, ForgeWorktreeBases } from './types.ts'

/** One remote with the URLs `git remote -v` prints for it. */
export interface GitRemote {
  /** Remote name such as `origin`. */
  readonly name: string
  /** Distinct URLs, fetch URL first. */
  readonly urls: readonly string[]
}

/**
 * Read the first line that `git rev-parse` prints for a directory query such as `--show-toplevel`.
 * @param output - stdout of the command.
 * @returns the directory.
 * @throws when the output is empty.
 */
export function parseTopLevel(output: string): string {
  const [root = ''] = output.split(/\r?\n/)
  if (root.length === 0) throw new Error('git rev-parse printed no directory')
  return root
}

/**
 * Read the first line of a one-name output such as `git symbolic-ref --quiet HEAD`.
 * @param output - stdout of the command.
 * @returns the name, or null when the command printed none.
 */
export function parseName(output: string): string | null {
  const [name = ''] = output.split(/\r?\n/)
  return name.length === 0 ? null : name
}

/** Ref prefixes of the branches the `branch` scope can compare with: local branches, then remote-tracking branches. */
export const BASE_REF_PREFIXES = ['refs/heads/', 'refs/remotes/'] as const

/**
 * Select the branches the `branch` scope can compare with from `git for-each-ref`
 * output, keeping its order and leaving out symbolic refs and the checked-out branch.
 * @param output - stdout of `git for-each-ref --format=%(refname)%00%(symref)` over {@link BASE_REF_PREFIXES}.
 * @param current - checked-out branch, or null when HEAD is detached.
 * @param query - text the names must contain, ignoring case; empty or blank for every branch.
 * @param limit - most branches in each group.
 * @returns remote-tracking and local branches, at most `limit` of each.
 */
export function parseBaseBranches(
  output: string,
  current: string | null,
  query: string,
  limit: number,
): { readonly remote: ForgeBaseBranch[]; readonly local: ForgeBaseBranch[] } {
  const [heads, remotes] = BASE_REF_PREFIXES
  const needle = query.trim().toLowerCase()
  const remote: ForgeBaseBranch[] = []
  const local: ForgeBaseBranch[] = []
  for (const line of output.split(/\r?\n/)) {
    const [ref = '', symref = ''] = line.split('\0')
    if (symref.length > 0) continue
    const group = ref.startsWith(heads) ? local : ref.startsWith(remotes) ? remote : undefined
    if (group === undefined || group.length >= limit) continue
    const name = ref.slice(group === local ? heads.length : remotes.length)
    if (name.length === 0 || (group === local && name === current) || !name.toLowerCase().includes(needle)) continue
    group.push({ ref, name })
  }
  return { remote, local }
}

/**
 * Select the branches a new worktree can start from out of `git for-each-ref` output, keeping its order within
 * each group: the checked-out branch, each remote's default branch, the other local branches, and the other
 * remote-tracking branches of each remote. A remote's default branch is the branch its `refs/remotes/<remote>/HEAD`
 * names; remote-tracking branches of unconfigured remotes and other symbolic refs are left out.
 * @param output - stdout of `git for-each-ref --format=%(refname)%00%(symref)` over {@link BASE_REF_PREFIXES}.
 * @param current - checked-out branch, or null when HEAD is detached.
 * @param remotes - configured remotes in the order their groups take.
 * @param query - text the names must contain, ignoring case; empty or blank for every branch.
 * @param limit - most branches in the local group and in each remote's group.
 * @param repositoryOf - the repository a remote's group names.
 * @returns the branches, with remotes that have no listed branch left out.
 */
export function parseWorktreeBases(
  output: string,
  current: string | null,
  remotes: readonly GitRemote[],
  query: string,
  limit: number,
  repositoryOf: (remote: GitRemote) => string | null,
): ForgeWorktreeBases {
  const [heads, tracking] = BASE_REF_PREFIXES
  const needle = query.trim().toLowerCase()
  const matches = (name: string): boolean => name.toLowerCase().includes(needle)
  const listed: string[] = []
  const remoteHeads = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const [ref = '', symref = ''] = line.split('\0')
    if (ref.length === 0) continue
    if (symref.length === 0) {
      listed.push(ref)
      continue
    }
    const owner = ref.startsWith(tracking) ? upstreamBranch(ref.slice(tracking.length), remotes) : undefined
    if (owner?.branch === 'HEAD') remoteHeads.set(owner.remote.name, symref)
  }
  const present = new Set(listed)
  const defaultRefs = new Set<string>()
  const defaults: ForgeRemoteDefault[] = []
  for (const remote of remotes) {
    const target = remoteHeads.get(remote.name)
    if (target === undefined || !present.has(target) || !target.startsWith(`${tracking}${remote.name}/`)) continue
    defaultRefs.add(target)
    const name = target.slice(tracking.length)
    if (matches(name)) defaults.push({ ref: target, name, remote: remote.name })
  }
  const local: ForgeBaseBranch[] = []
  const groups = remotes.map(remote => ({ remote, branches: [] as ForgeBaseBranch[] }))
  for (const ref of listed) {
    if (ref.startsWith(heads)) {
      const name = ref.slice(heads.length)
      if (name !== current && local.length < limit && matches(name)) local.push({ ref, name })
      continue
    }
    if (!ref.startsWith(tracking) || defaultRefs.has(ref)) continue
    const name = ref.slice(tracking.length)
    const owner = upstreamBranch(name, remotes)?.remote
    const group = groups.find(candidate => candidate.remote === owner)
    if (group !== undefined && group.branches.length < limit && matches(name)) group.branches.push({ ref, name })
  }
  const currentRef = `${heads}${current ?? ''}`
  return {
    current: current !== null && present.has(currentRef) && matches(current) ? { ref: currentRef, name: current } : null,
    defaults,
    local,
    remotes: groups.filter(group => group.branches.length > 0)
      .map(({ remote, branches }) => ({ name: remote.name, repository: repositoryOf(remote), branches })),
  }
}

/**
 * Group the lines of `git remote -v` by remote.
 * @param output - stdout of the command.
 * @returns remotes in first-listed order.
 */
export function parseRemotes(output: string): GitRemote[] {
  const remotes = new Map<string, string[]>()
  for (const line of output.split(/\r?\n/)) {
    const [, name = '', url = '', direction = ''] = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line) ?? []
    if (name.length === 0) continue
    let urls = remotes.get(name)
    if (urls === undefined) {
      urls = []
      remotes.set(name, urls)
    }
    if (urls.includes(url)) continue
    if (direction === 'fetch') urls.unshift(url)
    else urls.push(url)
  }
  return [...remotes].map(([name, urls]) => ({ name, urls }))
}

/**
 * Split an upstream branch such as `origin/feature/x` into its remote and the
 * branch on that remote. The remote is the longest remote name followed by `/`
 * at the start of the upstream branch.
 * @param upstream - upstream branch such as `origin/main`, or null.
 * @param remotes - remotes in listed order.
 * @returns the remote and branch, or undefined without an upstream or a remote it starts with.
 */
export function upstreamBranch(
  upstream: string | null,
  remotes: readonly GitRemote[],
): { readonly remote: GitRemote; readonly branch: string } | undefined {
  if (upstream === null) return undefined
  const remote = remotes
    .filter(candidate => upstream.startsWith(`${candidate.name}/`))
    .reduce<GitRemote | undefined>(
      (longest, candidate) => longest === undefined || candidate.name.length > longest.name.length ? candidate : longest,
      undefined,
    )
  return remote === undefined ? undefined : { remote, branch: upstream.slice(remote.name.length + 1) }
}

/**
 * Name the repository a remote's group shows: `owner/name` of the first URL a provider recognizes, else the first URL
 * without the user name and password a URL can carry as a token, since the name reaches the browser.
 * @param remote - remote with its URLs, fetch URL first.
 * @param recognize - the repository a provider recognizes from a URL, or undefined.
 * @returns the name, or null for a remote without a URL.
 */
export function remoteRepository(
  remote: GitRemote,
  recognize: (url: string) => { readonly owner: string; readonly name: string } | undefined,
): string | null {
  for (const url of remote.urls) {
    const repository = recognize(url)
    if (repository !== undefined) return `${repository.owner}/${repository.name}`
  }
  // A URL's user information ends at the last `@` before its path, query, or fragment.
  return remote.urls[0]?.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/, '$1') ?? null
}

/**
 * Order remotes for code host recognition: the upstream's remote first, then
 * `origin`, then the rest in listed order.
 * @param upstream - upstream branch such as `origin/main`, or null.
 * @param remotes - remotes in listed order.
 * @returns the same remotes in recognition order.
 */
export function remoteOrder(upstream: string | null, remotes: readonly GitRemote[]): GitRemote[] {
  const tracked = upstreamBranch(upstream, remotes)?.remote
  const rank = (remote: GitRemote): number => remote === tracked ? 0 : remote.name === 'origin' ? 1 : 2
  return [...remotes].sort((left, right) => rank(left) - rank(right))
}
