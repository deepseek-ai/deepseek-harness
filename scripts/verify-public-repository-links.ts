/** Reject tracked files that reference an unavailable legacy repository. */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const unavailableOwner = ['deepseek', 'ai'].join('-')
const unavailableRepositoryName = ['deepseek', 'harness', 'sdk'].join('-')
const unavailableRepository = `${unavailableOwner}/${unavailableRepositoryName}`
const archivedAgentNotePrefix = '.agents/notes/archived/'

const namedReferenceCharacters: Readonly<Record<string, string>> = {
  hyphen: '-',
  num: '#',
  period: '.',
  colon: ':',
  sol: '/',
}

/**
 * Normalize escaped repository references for source-text policy checks.
 * @param source - Source text containing literal, encoded, or compatibility characters.
 * @returns Lowercase text with URL, JavaScript, and HTML character escapes decoded.
 */
export function canonicalReferenceText(source: string): string {
  return source
    .normalize('NFKC')
    .replaceAll('\\/', '/')
    .replace(/\\(?:u([\da-f]{4})|x([\da-f]{2}))/gi, (_match, unicode: string | undefined, byte: string | undefined) =>
      String.fromCodePoint(Number.parseInt(unicode ?? byte ?? '', 16)))
    .replace(/%([\da-f]{2})/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(?:(\d+)|x([\da-f]+));/gi, (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      const code = Number.parseInt(decimal ?? hexadecimal ?? '', decimal === undefined ? 16 : 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity
    })
    .replace(/&(hyphen|num|period|colon|sol);/gi, (entity, name: string) => namedReferenceCharacters[name.toLowerCase()] ?? entity)
    .normalize('NFKC')
    .toLowerCase()
}

/** One tracked reference to the unavailable repository. */
export interface UnavailableRepositoryReference {
  /** Repository-relative file path. */
  file: string
  /** One-based source line. */
  line: number
}

/**
 * Locate unavailable-repository references in one active text file.
 * @param file - Repository-relative path used in diagnostics.
 * @param source - Text to inspect.
 * @returns every matching source line, excluding frozen archived Agent Notes.
 */
export function findUnavailableRepositoryReferences(file: string, source: string): UnavailableRepositoryReference[] {
  if (file.startsWith(archivedAgentNotePrefix)) return []

  const references: UnavailableRepositoryReference[] = []
  for (const [index, line] of source.split('\n').entries()) {
    const canonicalLine = canonicalReferenceText(line)
    if (canonicalLine.includes(unavailableRepository)) references.push({ file, line: index + 1 })
  }
  return references
}

function trackedFiles(repoRoot: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '')
}

function scanRepository(repoRoot: string): UnavailableRepositoryReference[] {
  const references: UnavailableRepositoryReference[] = []
  for (const file of trackedFiles(repoRoot)) {
    const path = resolve(repoRoot, file)
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isFile() && !stat.isSymbolicLink()) continue
    const source = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path, 'utf8')
    if (source.includes('\0')) continue
    references.push(...findUnavailableRepositoryReferences(file, source))
  }
  return references
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const references = scanRepository(root)
  if (references.length === 0) {
    console.log('verify-public-repository-links: tracked files reference no unavailable repository.')
  } else {
    console.error('verify-public-repository-links: unavailable repository references found:')
    for (const reference of references) console.error(`  ${reference.file}:${String(reference.line)}`)
    process.exitCode = 1
  }
}
