/** Pure archive-format, triplet, and immutable-manifest helpers. */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { AGENT_NOTE_CLASSES } from './agent-note-tree.ts'

/** Versioned fields in the frozen-content manifest. */
export interface ArchiveManifest {
  version: 1
  files: Readonly<Record<string, string>>
}

/** Hash one archived artifact independently of the repository's Git object format. */
function archiveContentHash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/** Compute the SHA-1 Git blob id used by bilingual consistency sidecars. */
export function gitBlobHash(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.byteLength}\0`)
  hash.update(content)
  return hash.digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the archive manifest and reject fields or hashes outside its closed schema. */
export function parseArchiveManifest(content: string): ArchiveManifest {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  const fields = Object.keys(value).sort()
  if (fields.join(',') !== 'files,version') throw new Error('expected exactly the fields `version` and `files`')
  if (value.version !== 1) throw new Error('unsupported manifest version (expected 1)')
  if (!isRecord(value.files)) throw new Error('`files` must be an object')
  const files: Record<string, string> = {}
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid content hash for ${path}`)
    }
    files[path] = hash
  }
  return { version: 1, files }
}

/** Render the archive manifest with deterministic path ordering. */
export function renderArchiveManifest(files: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  }, null, 2)}\n`
}

// Exact seals for the authorized Figma-link removal and its bilingual sidecar.
const figmaLinkRemovals = [
  {
    path: 'feature/2026-08-10-durable-workflow-runs-in-chat.md',
    before: 'sha256:f9f5290cd880908d17b1080ae5776f22e182f5253471f90cf8bead418b33b502',
    after: 'sha256:6018de4a89ca99d6cbfd618aff1c8136b23d8e4854a30f7b12a602f0417cbdc2',
  },
  {
    path: 'feature/2026-08-10-durable-workflow-runs-in-chat.zh.md',
    before: 'sha256:f4ffd2700bc9c2a0cc4b9d90f84e1d0a576939e2e6f0b130c5b142fd8cd518b0',
    after: 'sha256:0080859221773122022d5880efa3d52f29c0872b52d63e170250d94f214ff37a',
  },
  {
    path: 'feature/2026-08-10-durable-workflow-runs-in-chat.i18n.yaml',
    before: 'sha256:0db3c21a3c8785e56d5d7b90df990b158069cd1cea664e62fc4786c6d7588450',
    after: 'sha256:03eadb60c8ba4fde262cd61e3f911d8cd68ea4a58f57adeb8dd7bb9a97d08ca2',
  },
]

/** Reject sealed changes except the exact authorized Figma-link removal hashes. */
export function validateArchiveManifestExtension(
  baseline: ArchiveManifest,
  current: ArchiveManifest,
): string[] {
  const errors: string[] = []
  for (const [path, expected] of Object.entries(baseline.files)) {
    const actual = current.files[path]
    if (actual === undefined) errors.push(`${path}: sealed manifest entry is missing`)
    else if (actual !== expected && !figmaLinkRemovals.some(change =>
      change.path === path && change.before === expected && change.after === actual,
    )) errors.push(`${path}: sealed manifest hash changed`)
  }
  return errors
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

interface Triplet {
  source?: Buffer
  zh?: Buffer
  meta?: Buffer
}

function pairMeta(content: string): Map<string, string> | undefined {
  const entries = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const match = /^([^:#]+\.md): ([0-9a-f]{40})$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) return undefined
    entries.set(match[1], match[2])
  }
  return entries
}

function validateMetadata(path: string, content: Buffer, sourceBase: string): { errors: string[]; date: string | undefined } {
  const errors: string[] = []
  const lines = content.toString('utf8').split('\n')
  const status = lines.findIndex(line => line.startsWith('Status:'))
  if (lines[status] !== 'Status: implemented') errors.push(`${path}: requires \`Status: implemented\``)
  const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[status + 1] ?? '')?.[1]
  if (status < 0 || archived === undefined || !validDate(archived)) {
    errors.push(`${path}: requires \`Archived: YYYY-MM-DD\` with a valid date immediately after the status`)
  } else if (archived < sourceBase.slice(0, 10)) {
    errors.push(`${path}: archive date ${archived} predates the note filename`)
  }
  return { errors, date: archived }
}

/** Validate the closed kind tree, implemented/archive metadata, and complete bilingual triplets. */
export function validateArchiveArtifacts(artifacts: ReadonlyMap<string, Buffer>): string[] {
  const errors: string[] = []
  const triplets = new Map<string, Triplet>()
  for (const [path, content] of artifacts) {
    const match = /^([^/]+)\/(\d{4}-\d{2}-\d{2}-.+?)(\.zh\.md|\.i18n\.yaml|\.md)$/.exec(path)
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.{md,zh.md,i18n.yaml}`)
      continue
    }
    if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(match[1])) {
      errors.push(`${path}: unknown Agent Note kind ${JSON.stringify(match[1])}`)
      continue
    }
    const key = `${match[1]}/${match[2]}`
    const triplet = triplets.get(key) ?? {}
    if (match[3] === '.md') triplet.source = content
    else if (match[3] === '.zh.md') triplet.zh = content
    else triplet.meta = content
    triplets.set(key, triplet)
  }

  for (const [key, triplet] of [...triplets].sort(([left], [right]) => left.localeCompare(right))) {
    const sourcePath = `${key}.md`
    const zhPath = `${key}.zh.md`
    const metaPath = `${key}.i18n.yaml`
    const { source, zh, meta } = triplet
    const missing = [
      source === undefined ? sourcePath : undefined,
      zh === undefined ? zhPath : undefined,
      meta === undefined ? metaPath : undefined,
    ].filter((path): path is string => path !== undefined)
    if (source === undefined || zh === undefined || meta === undefined) {
      errors.push(`${key}: incomplete archived triplet; missing ${missing.join(', ')}`)
      continue
    }
    const sourceBase = basename(key)
    const { errors: sourceErrors, date: sourceDate } = validateMetadata(sourcePath, source, sourceBase)
    const { errors: zhErrors, date: zhDate } = validateMetadata(zhPath, zh, sourceBase)
    errors.push(...sourceErrors, ...zhErrors)
    if (sourceDate !== undefined && zhDate !== undefined && sourceDate !== zhDate) {
      errors.push(`${key}: English and Chinese archive dates differ (${sourceDate} vs ${zhDate})`)
    }
    const pair = pairMeta(meta.toString('utf8'))
    if (pair === undefined || pair.size !== 2
      || pair.get(`${sourceBase}.md`) !== gitBlobHash(source)
      || pair.get(`${sourceBase}.zh.md`) !== gitBlobHash(zh)) {
      errors.push(`${metaPath}: consistency record must contain the current Git blob hashes of both archived sides`)
    }
  }
  return errors
}

/** Preserve every sealed path/hash and append hashes for newly archived artifacts. */
export function extendArchiveManifest(
  existing: ArchiveManifest,
  artifacts: ReadonlyMap<string, Buffer>,
): { files: Record<string, string>; added: string[]; errors: string[] } {
  const errors: string[] = []
  const files: Record<string, string> = { ...existing.files }
  for (const [path, expected] of Object.entries(existing.files)) {
    const content = artifacts.get(path)
    if (content === undefined) errors.push(`${path}: sealed artifact is missing`)
    else if (archiveContentHash(content) !== expected) errors.push(`${path}: sealed content hash changed`)
  }
  const added: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    if (files[path] !== undefined) continue
    files[path] = archiveContentHash(content)
    added.push(path)
  }
  return { files, added, errors }
}
