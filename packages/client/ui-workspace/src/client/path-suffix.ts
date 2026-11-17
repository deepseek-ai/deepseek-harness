/** Path suffixes that tell same-titled Workspaces apart. */

/**
 * Map each Workspace whose display title another listed Workspace shares to
 * the shortest run of trailing path segments that no other same-titled
 * Workspace's path ends with, keeping the path's own separators. Workspaces
 * with a unique title get no entry.
 * @param workspaces - id, display title, and canonical path of each listed Workspace.
 * @returns distinguishing suffix by Workspace id.
 */
export function distinguishingPathSuffixes<Id>(
  workspaces: readonly { readonly id: Id; readonly title: string; readonly path: string }[],
): ReadonlyMap<Id, string> {
  // Segments and the separators between them alternate: `/a/b` → ['', '/', 'a', '/', 'b'].
  const rows = workspaces.map(workspace => ({ ...workspace, parts: workspace.path.split(/([\\/])/) }))
  const suffix = (parts: readonly string[], count: number): string => parts.slice(-(2 * count - 1)).join('')
  const suffixes = new Map<Id, string>()
  for (const row of rows) {
    const peers = rows.filter(other => other !== row && other.title === row.title)
    if (peers.length === 0) continue
    let count = 1
    // A root path (`/`, `C:\`) ends in an empty segment; grow past it.
    while (2 * count - 1 < row.parts.length && (suffix(row.parts, count) === '' || peers.some(peer => suffix(peer.parts, count) === suffix(row.parts, count)))) count++
    suffixes.set(row.id, suffix(row.parts, count))
  }
  return suffixes
}
