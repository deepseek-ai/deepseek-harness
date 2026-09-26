/** Git index reads owned by the bilingual pairing gate. */

import { spawnSync } from 'node:child_process'

/**
 * Run one Git subprocess and return its exact stdout bytes.
 *
 * @param root - Repository root used as Git's working directory.
 * @param args - Arguments following the `git` executable.
 * @param operation - Human-readable operation for failure diagnostics.
 * @returns Exact stdout bytes.
 * @throws Error when Git cannot start or exits unsuccessfully.
 */
function runGit(root: string, args: string[], operation: string): Buffer {
  const result = spawnSync('git', ['-C', root, ...args], { maxBuffer: 1 << 26 })
  if (result.error) {
    throw new Error(`${operation} failed: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(`${operation} failed with status ${String(result.status)}: ${result.stderr.toString('utf8').trim()}`)
  }
  return result.stdout
}

/** Every stage-zero path currently present in the Git index. */
export function gitIndexPaths(root: string): Set<string> {
  const paths = new Set<string>()
  const entries = runGit(root, ['ls-files', '--stage', '-z'], 'listing Git index paths')
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  for (const entry of entries) {
    const match = /^\d+ [0-9a-f]+ ([0-3])\t([\s\S]+)$/.exec(entry)
    if (!match?.[1] || match[2] === undefined) throw new Error('git ls-files --stage returned a malformed entry')
    if (match[1] === '0') paths.add(match[2])
  }
  return paths
}

/**
 * Read one path from the Git index without consulting working-tree bytes.
 *
 * @param root - Repository root.
 * @param path - Repository-relative path.
 * @returns The stage-zero blob bytes, or `undefined` when the path is absent.
 * @throws Error when the path is unmerged or its index entries are not a valid merge state.
 */
export function readGitIndexBlob(root: string, path: string): Buffer | undefined {
  const output = runGit(
    root,
    ['ls-files', '--stage', '-z', '--', path],
    `git ls-files --stage for ${path}`,
  ).toString('utf8')
  const entries = output.split('\0').filter(Boolean)
  if (entries.length === 0) return undefined
  if (entries.length !== 1) throw new Error(`${path} does not have exactly one resolved index entry`)
  const match = /^(?:\d+) ([0-9a-f]+) 0\t[\s\S]+$/.exec(entries[0] ?? '')
  if (!match?.[1]) throw new Error(`${path} remains unmerged or has an invalid index entry`)
  return runGit(root, ['cat-file', 'blob', match[1]], `reading staged ${path}`)
}
