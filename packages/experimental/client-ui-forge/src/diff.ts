/** Unified patch parsing into the panel's browser-safe diff model, and the diff and size of an untracked file. */

import { parsePatch } from 'diff'
import type { ForgeChangedFile, ForgeDiffFile, ForgeDiffStatus } from './types.ts'

/** Git's name for the missing side of an added or deleted file. */
const NULL_PATH = '/dev/null'

/** Bytes Git inspects for a NUL byte before it calls content binary. */
const BINARY_PROBE_BYTES = 8000

/**
 * Parse a Git-style unified patch, as `git diff` or a code host prints it,
 * with `a/` and `b/` path prefixes. Hunk ranges follow jsdiff: a range that
 * covers no line starts at the line it comes before.
 * @param patch - the patch text.
 * @returns one file per patch section in patch order.
 */
export function parseDiff(patch: string): ForgeDiffFile[] {
  return parsePatch(patch).flatMap((section) => {
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
    return [{
      path,
      previousPath: status === 'renamed' ? before : null,
      status,
      binary: section.isBinary === true,
      oversized: false,
      untracked: false,
      additions,
      deletions,
      hunks: section.hunks.map(({ oldStart, oldLines, newStart, newLines, lines }) => ({ oldStart, oldLines, newStart, newLines, lines })),
    }]
  })
}

/**
 * Describe an untracked file as added in full.
 * @param path - path relative to the repository root.
 * @param content - the file's bytes.
 * @returns the file with one hunk of added lines, none when it is empty, or none and `binary` when its content is not text.
 */
export function untrackedFile(path: string, content: Uint8Array): ForgeDiffFile {
  const file: ForgeDiffFile = {
    path, previousPath: null, status: 'added', binary: false, oversized: false, untracked: true, additions: 0, deletions: 0, hunks: [],
  }
  const text = decodeText(content)
  if (text === undefined) return { ...file, binary: true }
  if (text.length === 0) return file
  const lines = text.split('\n')
  const ended = lines.at(-1) === ''
  if (ended) lines.pop()
  return {
    ...file,
    additions: lines.length,
    hunks: [{
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: [...lines.map(line => `+${line}`), ...ended ? [] : ['\\ No newline at end of file']],
    }],
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
