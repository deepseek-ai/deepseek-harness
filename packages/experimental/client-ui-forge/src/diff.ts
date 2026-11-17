/** Unified patch parsing into the panel's browser-safe diff model, and the diff and size of an untracked file. */

import { createHash } from 'node:crypto'
import { parsePatch } from 'diff'
import type { ForgeChangedFile, ForgeDiffFile, ForgeDiffHunk, ForgeDiffStatus } from './types.ts'

/** A changed file before its path is classified into a review layer. */
export type ParsedDiffFile = Omit<ForgeDiffFile, 'layer'>

/** Git's name for the missing side of an added or deleted file. */
const NULL_PATH = '/dev/null'

/** Bytes Git inspects for a NUL byte before it calls content binary. */
const BINARY_PROBE_BYTES = 8000

/** Blob names of both sides on a Git `index` header line, which identify a binary change that carries no hunks. */
const INDEX_LINE = /^index ([0-9a-f]+\.\.[0-9a-f]+)/m

/**
 * Parse a Git-style unified patch, as `git diff` or a code host prints it,
 * with `a/` and `b/` path prefixes. Hunk ranges follow jsdiff: a range that
 * covers no line starts at the line it comes before.
 * @param patch - the patch text.
 * @returns one file per patch section in patch order.
 */
export function parseDiff(patch: string): ParsedDiffFile[] {
  const parsed = parsePatch(patch)
  // Hunk lines start with a space, `+`, `-`, or `\`, so only a Git section header starts a line with `diff --git `.
  const headers = patch.split(/^(?=diff --git )/m).filter(section => section.startsWith('diff --git '))
  return parsed.flatMap((section, index) => {
    const before = pathOf(section.oldFileName, 'a/')
    const after = pathOf(section.newFileName, 'b/')
    const path = after ?? before
    if (path === null) return []
    const status: ForgeDiffStatus = section.isCreate === true || before === null ? 'added'
      : section.isDelete === true || after === null ? 'deleted'
        : section.isRename === true ? 'renamed' : 'modified'
    let additions = 0
    let deletions = 0
    for (const hunk of section.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) additions++
        else if (line.startsWith('-')) deletions++
      }
    }
    const binary = section.isBinary === true
    const previousPath = status === 'renamed' ? before : null
    const hunks = section.hunks.map(({ oldStart, oldLines, newStart, newLines, lines }) => (
      { oldStart, oldLines, newStart, newLines, lines }))
    // Each header matches its parsed section only when every section starts with a Git header.
    const header = binary && headers.length === parsed.length ? String(headers[index]) : ''
    const blobs = INDEX_LINE.exec(header)?.[1] ?? ''
    // A mode change, such as `chmod +x`, shows only in the `old mode` and `new mode` header lines.
    const modes = `${section.oldMode ?? ''}..${section.newMode ?? ''}`
    return [{
      path, previousPath, status, binary, oversized: false, untracked: false, additions, deletions, hunks,
      digest: changeDigest(path, previousPath, status, hunks, blobs, modes),
    }]
  })
}

/** Digest of one change: its paths, status, hunks, file modes, and the identity of content that hunks do not show. */
function changeDigest(
  path: string, previousPath: string | null, status: ForgeDiffStatus, hunks: readonly ForgeDiffHunk[], content: string, modes: string,
): string {
  return createHash('sha256').update(JSON.stringify([path, previousPath, status, hunks, content, modes])).digest('hex').slice(0, 32)
}

/**
 * Describe an untracked file as added in full.
 * @param path - path relative to the repository root.
 * @param content - the file's bytes.
 * @returns the file with one hunk of added lines, none when it is empty, or none and `binary` when its content is not text.
 */
export function untrackedFile(path: string, content: Uint8Array): ParsedDiffFile {
  const text = decodeText(content)
  if (text === undefined) return addedFile(path, [], { binary: true, oversized: false, content: createHash('sha256').update(content).digest('hex') })
  if (text.length === 0) return addedFile(path, [], { binary: false, oversized: false, content: '' })
  const lines = text.split('\n')
  const ended = lines.at(-1) === ''
  if (ended) lines.pop()
  return addedFile(path, [{
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: [...lines.map(line => `+${line}`), ...ended ? [] : ['\\ No newline at end of file']],
  }], { binary: false, oversized: false, content: '' })
}

/**
 * Describe an untracked file over `maxDiffBytes`, which carries no hunks and whose content is not read.
 * @param path - path relative to the repository root.
 * @returns the oversized added file.
 */
export function oversizedUntrackedFile(path: string): ParsedDiffFile {
  return addedFile(path, [], { binary: false, oversized: true, content: 'oversized' })
}

/** An untracked file as added, whose digest also covers `content`, the identity of content its hunks do not show. */
function addedFile(path: string, hunks: readonly ForgeDiffHunk[], { binary, oversized, content }: {
  readonly binary: boolean
  readonly oversized: boolean
  readonly content: string
}): ParsedDiffFile {
  return {
    path, previousPath: null, status: 'added', binary, oversized, untracked: true,
    additions: hunks[0]?.newLines ?? 0, deletions: 0, hunks, digest: changeDigest(path, null, 'added', hunks, content, ''),
  }
}

/**
 * Decode file content as text the way Git decides it is not binary: no NUL
 * byte among the first 8000 bytes, and, here, valid UTF-8 throughout.
 * @param content - the bytes.
 * @returns the text, or undefined for binary content.
 */
export function decodeText(content: Uint8Array): string | undefined {
  if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch (error) {
    void error // Bytes that are not UTF-8 render as binary, as a NUL byte does.
    return undefined
  }
}

/**
 * Parse `git diff --numstat -z` output, in which a rename prints its counts,
 * an empty path, and then the old and new paths as separate fields.
 * @param output - the command's standard output.
 * @returns one file per record, named by its new path; a binary file counts no lines.
 */
export function parseNumstat(output: string): ForgeChangedFile[] {
  const fields = output.split('\0')
  const files: ForgeChangedFile[] = []
  let skip = 0
  for (const [index, record] of fields.entries()) {
    if (skip > 0) {
      skip--
      continue
    }
    if (record.length === 0) continue
    const [added = '', deleted = ''] = record.split('\t', 2)
    let path = record.slice(added.length + deleted.length + 2)
    if (path.length === 0) {
      const renamed = fields[index + 2]
      // A rename record that the output limit cut off ends the list.
      if (renamed === undefined) break
      path = renamed
      skip = 2
    }
    const binary = added === '-'
    files.push({ path, additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary })
  }
  return files
}

function pathOf(name: string | undefined, prefix: string): string | null {
  if (name === undefined || name === NULL_PATH) return null
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}
