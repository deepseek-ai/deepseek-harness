/** Parsers for the porcelain output of the read-only Git commands the panel runs. */

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
 * Read the first line of a one-name output such as `git symbolic-ref --short HEAD`.
 * @param output - stdout of the command.
 * @returns the name, or null when the command printed none.
 */
export function parseName(output: string): string | null {
  const [name = ''] = output.split(/\r?\n/)
  return name.length === 0 ? null : name
}

/**
 * Order worktree base branches: the checked-out branch first, then the other
 * listed branches in listed order.
 * @param current - checked-out branch, or null when HEAD is detached.
 * @param output - stdout of `git for-each-ref --format=%(refname:lstrip=2) refs/heads/`.
 * @param limit - most names to return.
 * @returns distinct branch names, at most `limit`.
 */
export function baseBranches(current: string | null, output: string, limit: number): string[] {
  const listed = output.split(/\r?\n/).filter(name => name.length > 0 && name !== current)
  return (current === null ? listed : [current, ...listed]).slice(0, limit)
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
