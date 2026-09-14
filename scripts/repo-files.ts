/** Shared repository file discovery and line-oriented reference scanning. */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** One authored path plus its canonical target for symlink deduplication. */
export interface RepoFile {
  /** Absolute path matched by the caller's glob. */
  abs: string
  /** Absolute canonical path used only for deduplication. */
  real: string
}

/** A rejected line-oriented repository reference. */
export interface ReferenceViolation {
  /** Repo-relative file containing the reference. */
  file: string
  /** 1-based line containing the reference. */
  line: number
  /** Normalized reference text. */
  ref: string
}

/** Whether a repository path is frozen Agent Note history, not evolving source prose. */
export function isArchivedAgentNotePath(path: string): boolean {
  return path.replaceAll('\\', '/').startsWith('.agents/notes/archived/')
}

/**
 * Whether a pattern segment matches a directory or file name. Supports `*` and
 * `?` inside a segment and mirrors node's glob `dot: false`: a segment whose
 * first character is a wildcard does not match dot names. `**` is handled as a
 * whole segment by the walker, never here.
 */
function segmentMatches(pattern: string, name: string): boolean {
  if (name.startsWith('.') && (pattern.startsWith('*') || pattern.startsWith('?'))) return false
  let expression = ''
  for (const character of pattern) {
    if (character === '*') expression += '.*'
    else if (character === '?') expression += '.'
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${expression}$`).test(name)
}

/**
 * Reject glob syntax the walker does not model. Node's `fs.glob` understands
 * character classes, brace alternation, and extglobs; expanding those
 * silently as literals would match nothing and quietly shrink a gate's
 * corpus, so a pattern segment using them fails loudly instead. Pure literal
 * segments must therefore contain none of the rejected metacharacters
 * either, even where node glob would read them literally.
 */
const UNSUPPORTED_GLOB = /[[\]{}()!+@\\]/

function assertSupportedSegment(segment: string): void {
  if (UNSUPPORTED_GLOB.test(segment)) {
    throw new TypeError(`repo-files walker does not model glob syntax in segment: ${segment}`)
  }
}

/**
 * Walk `root` matching one repository-relative glob without node's `fs.glob`.
 * The repository's own walker exists because node's internal glob, from some
 * 24.x releases, lstat-probes `<matched>/<next segment>` for symlinked files
 * while expanding `**` and throws ENOTDIR instead of skipping (observed on
 * node 24.13.0 scanning `snapshots/acp/image-compaction`'s symlinked
 * `system-prompt.expected.md`). The walker decides directoryhood from dirent
 * types and stat results, never by probing a path under a file, so the same
 * tree enumerates identically on every node version.
 *
 * Segment semantics: literal segments resolve through `stat`, so a literal
 * naming a symlinked directory enters that directory exactly as node glob
 * does — including a literal repeated across segments, which node glob
 * resolves each time; wildcard segments and `**` resolve through dirent
 * types, so they never enter symlinked directories and never match dot
 * names. Node documents `follow: false` only for `**` expansion, so the
 * wildcard-side behavior is this walker's own contract, pinned by
 * repo-files.spec.ts, rather than a cross-version node guarantee; the four
 * consuming gates' current patterns contain no wildcard segment over a
 * symlinked directory, so the corpus is unchanged. `**` spans zero or more
 * directories. The final segment matches files and symlinks; a broken or
 * cyclic symlink then fails loudly in the caller's realpathSync rather than
 * shrinking the scanned corpus, while a broken symlink under a literal
 * non-final segment matches nothing, again as node glob does. Traversal
 * terminates without a visited set: each literal segment consumes one pattern
 * segment per recursion, and `**` recurses only into real directories, which
 * form a finite tree because symlinked directories are never expanded by it.
 * Pattern segments support `*`, `?`, and literals that contain none of
 * `[]{}()!+@\`; other node-glob syntax, including a trailing `**`, `..`, and
 * empty segments, is rejected loudly up front, while a `.` segment is folded
 * away exactly as node glob normalizes it. Returns repository-relative slash
 * paths, sorted.
 */
function expandGlob(root: string, pattern: string): string[] {
  const segments: string[] = []
  for (const segment of pattern.split('/')) {
    if (segment === '.') {
      // Node glob normalizes a `.` segment away; dropping it here keeps
      // `./README.md` and `a/./b` matching exactly as node glob does instead
      // of silently matching nothing.
      continue
    }
    if (segment === '..') {
      // A `..` segment escapes the scanned root and interacts with `**` in
      // ways node glob special-cases; no gate pattern uses one, so the walker
      // rejects the form loudly instead of silently matching nothing.
      throw new TypeError(`repo-files walker does not model .. segments in pattern: ${pattern}`)
    }
    if (segment === '') {
      // A leading, doubled, or trailing slash yields an empty segment that
      // can never match an entry; node glob would tolerate the form, so the
      // walker must reject it loudly instead of silently returning nothing.
      throw new TypeError(`repo-files walker does not model empty segments in pattern: ${pattern}`)
    }
    segments.push(segment)
  }
  if (segments.length === 0) {
    throw new TypeError(`repo-files walker does not model a pattern with no segments: ${pattern}`)
  }
  for (const segment of segments) {
    if (segment !== '**') assertSupportedSegment(segment)
  }
  // A trailing `**` would match files, directories, and symlinks below the
  // prefix; the walker models `**` only as a directory-spanning segment, so
  // it must reject the form loudly instead of silently returning nothing.
  if (segments[segments.length - 1] === '**') {
    throw new TypeError(`repo-files walker does not model a trailing ** segment in pattern: ${pattern}`)
  }
  const out: string[] = []

  const visit = (dirAbs: string, dirRel: string, index: number): void => {
    if (index >= segments.length) return
    if (segments[index] !== '**') {
      visitSegment(dirAbs, dirRel, index)
      return
    }
    // `**` consumes zero directories here and one directory per recursion.
    visitSegment(dirAbs, dirRel, index + 1)
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue
      visit(join(dirAbs, entry.name), dirRel === '.' ? entry.name : `${dirRel}/${entry.name}`, index)
    }
  }

  const visitSegment = (dirAbs: string, dirRel: string, index: number): void => {
    if (index >= segments.length) return
    const segment = segments[index]
    if (segment === undefined) return
    if (segment === '**') {
      visit(dirAbs, dirRel, index)
      return
    }
    const last = index === segments.length - 1
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (!segmentMatches(segment, entry.name)) continue
      const childAbs = join(dirAbs, entry.name)
      const childRel = dirRel === '.' ? entry.name : `${dirRel}/${entry.name}`
      if (last) {
        // Files and symlinks match; a broken or cyclic symlink then fails
        // loudly in the caller's realpathSync exactly as node glob did,
        // rather than silently shrinking the scanned corpus.
        if (entry.isFile() || entry.isSymbolicLink()) out.push(childRel)
        continue
      }
      if (entry.isDirectory()) {
        visitSegment(childAbs, childRel, index + 1)
        continue
      }
      // A literal non-final segment resolves through stat like node glob's,
      // so it enters a symlinked directory; wildcard segments never reach
      // this branch because they are matched from dirent types above.
      if (!entry.isSymbolicLink() || hasWildcard(segment)) continue
      let target: ReturnType<typeof statSync>
      try {
        target = statSync(childAbs)
      } catch {
        // A broken symlink matches nothing under a literal segment, as node
        // glob silently returns no match for it.
        continue
      }
      if (!target.isDirectory()) continue
      visitSegment(childAbs, childRel, index + 1)
    }
  }

  visit(root, '.', 0)
  return out.sort()
}

/** Whether a pattern segment contains `*` or `?` and is therefore wildcard. */
function hasWildcard(segment: string): boolean {
  return segment.includes('*') || segment.includes('?')
}

/**
 * Expand repository-relative globs and deduplicate symlinked files.
 * @param root - absolute repository root.
 * @param patterns - repository-relative glob patterns, processed in order.
 * @param isExcluded - optional predicate over each matched relative path.
 * @returns matched files in stable first-seen order.
 */
export function uniqueRepoFiles(
  root: string,
  patterns: readonly string[],
  isExcluded: (relativePath: string) => boolean = () => false,
): RepoFile[] {
  const seen = new Set<string>()
  const files: RepoFile[] = []
  for (const pattern of patterns) {
    for (const repoPath of expandGlob(root, pattern)) {
      if (isExcluded(repoPath)) continue
      const abs = resolve(root, repoPath)
      const real = realpathSync(abs)
      if (seen.has(real)) continue
      seen.add(real)
      files.push({ abs, real })
    }
  }
  return files
}

/**
 * Scan regex matches line by line and return the normalized matches rejected by
 * a caller predicate.
 * @param root - absolute repository root used for violation paths.
 * @param absPath - absolute text-file path to scan.
 * @param pattern - global regex matched independently against each line.
 * @param normalize - maps raw regex text to the reference the gate evaluates.
 * @param isViolation - returns true when the normalized reference is invalid.
 * @returns every rejected reference in source order.
 */
export function findReferenceViolations(
  root: string,
  absPath: string,
  pattern: RegExp,
  normalize: (raw: string) => string,
  isViolation: (ref: string) => boolean,
): ReferenceViolation[] {
  const file = relative(root, absPath).split(sep).join('/')
  const out: ReferenceViolation[] = []
  const lines = readFileSync(absPath, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    for (const match of line.matchAll(pattern)) {
      const ref = normalize(match[0])
      if (isViolation(ref)) out.push({ file, line: i + 1, ref })
    }
  }
  return out
}
