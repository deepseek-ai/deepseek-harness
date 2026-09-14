/** Verify the pinned prerelease archive without Git, network access, or source extraction. */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JSON_SCHEMA, load } from 'js-yaml'
import { classifyPersistenceChange, parseHistoricalPersistenceSnapshot } from './persistence-changes.ts'
import type { PersistenceTypeChange } from './persistence-changes.ts'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import type { PersistenceRoot, PersistenceSchemaInventory } from './persistence-schema-model.ts'
import { persistenceReleaseFactArtifacts } from './persistence-release-facts.ts'

const ARCHIVE_DIRECTORY = 'docs/persistence-changes/releases'
const TAG_PATTERN = /^dsh-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(alpha|rc)\.(0|[1-9]\d*)$/u
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u

/** Published identity and version constants observed in one pinned tag. */
export interface PersistenceRelease {
  readonly tag: string
  readonly sourceDate: string
  readonly publishedAt: string | null
  readonly sessionFormatVersion: number
}

/** Offline corpus captured from the repository's alpha and release-candidate tags. */
export interface PersistenceReleaseManifest {
  readonly schemaVersion: 1
  readonly capturedAt: string
  readonly releases: readonly PersistenceRelease[]
}

/** One changed root between consecutive archived releases. */
export interface PersistenceReleaseChange {
  readonly root: string
  readonly before: string | null
  readonly after: string | null
}

/** Machine declaration shared byte-for-byte by a release's bilingual documents. */
export interface PersistenceReleaseRecord {
  readonly schemaVersion: 1
  readonly tag: string
  readonly previous: string | null
  readonly sessionFormatVersion: number
  readonly changes: readonly PersistenceReleaseChange[]
}

/** Validated release, changed after schemas, and complete reconstructed root state. */
export interface PersistenceReleaseEntry {
  readonly release: PersistenceRelease
  readonly record: PersistenceReleaseRecord
  readonly snapshot: PersistenceSchemaInventory
  readonly roots: ReadonlyMap<string, PersistenceRoot>
  readonly differences: readonly (PersistenceTypeChange & { readonly root: string })[]
}

/** Complete validated archive; classifications describe modern rules, not historical migration obligations. */
export interface PersistenceReleases {
  readonly manifest: PersistenceReleaseManifest
  readonly entries: readonly PersistenceReleaseEntry[]
}

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`)
  const result = value as Record<string, unknown>
  const missing = fields.find(field => !Object.hasOwn(result, field))
  const extra = Object.keys(result).find(field => !fields.includes(field))
  if (missing !== undefined || extra !== undefined) throw new Error(`${label}: ${missing === undefined ? `unknown field ${extra}` : `missing field ${missing}`}`)
  return result
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`)
  return value
}

function string(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label}: invalid value`)
  return value
}

function version(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}: expected a nonnegative integer`)
  return value as number
}

function timestamp(value: unknown, label: string): void {
  const source = string(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u, label)
  if (!Number.isFinite(Date.parse(source))) throw new Error(`${label}: invalid timestamp`)
}

function tagOrder(tag: string): number[] {
  const match = TAG_PATTERN.exec(tag) as RegExpExecArray
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === 'alpha' ? 0 : 1, Number(match[5])]
}

function compareTags(left: string, right: string): number {
  const before = tagOrder(left)
  const after = tagOrder(right)
  return before.map((value, index) => value - (after[index] as number)).find(value => value !== 0) ?? 0
}

function parseManifest(value: unknown): PersistenceReleaseManifest {
  const input = object(value, ['schemaVersion', 'capturedAt', 'releases'], 'release manifest')
  if (input.schemaVersion !== 1) throw new Error('unsupported persistence release manifest schema version')
  const date = string(input.capturedAt, /^\d{4}-\d{2}-\d{2}$/u, 'capture date')
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('release manifest: invalid capture date')
  let previous: string | undefined
  const releases = array(input.releases, 'releases')
  if (releases.length === 0) throw new Error('release manifest: releases must not be empty')
  for (const raw of releases) {
    const release = object(raw, ['tag', 'sourceDate', 'publishedAt', 'sessionFormatVersion'], 'release')
    const tag = string(release.tag, TAG_PATTERN, 'release tag')
    if (previous !== undefined && compareTags(previous, tag) >= 0) throw new Error(`${tag}: release tags must be unique and in semantic-version order`)
    previous = tag
    timestamp(release.sourceDate, `${tag} source date`)
    if (release.publishedAt !== null) timestamp(release.publishedAt, `${tag} publication date`)
    version(release.sessionFormatVersion, `${tag} Session format version`)
  }
  return input as unknown as PersistenceReleaseManifest
}

function machineBlock(source: string, label: string): string {
  if (/\.[cm]?[jt]sx?(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)/u.test(source)) {
    throw new Error(`${label}: historical source references must omit line numbers`)
  }
  const metadata = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source)?.[1]
  const frontmatter: unknown = metadata === undefined ? undefined : load(metadata, { schema: JSON_SCHEMA })
  if (frontmatter === null || typeof frontmatter !== 'object' || !('kind' in frontmatter) || frontmatter.kind !== 'persistence-release') {
    throw new Error(`${label}: expected persistence-release frontmatter kind`)
  }
  const blocks = [...source.matchAll(/^```yaml persistence-release[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/gmu)]
  if (blocks.length !== 1) throw new Error(`${label}: expected exactly one persistence-release machine record`)
  return (blocks[0] as RegExpMatchArray)[1] as string
}

function parseRecord(source: string, release: PersistenceRelease, previous: string | null): PersistenceReleaseRecord {
  const input = object(load(source, { schema: JSON_SCHEMA }), ['schemaVersion', 'tag', 'previous', 'sessionFormatVersion', 'changes'], release.tag)
  if (input.schemaVersion !== 1) throw new Error(`${release.tag}: unsupported persistence release record schema version`)
  for (const field of ['tag', 'sessionFormatVersion'] as const) {
    if (input[field] !== release[field]) throw new Error(`${release.tag}: record ${field} does not match manifest`)
  }
  if (input.previous !== previous) throw new Error(`${release.tag}: predecessor must be ${String(previous)}`)
  const roots = new Set<string>()
  for (const raw of array(input.changes, `${release.tag} changes`)) {
    const change = object(raw, ['root', 'before', 'after'], release.tag)
    const root = string(change.root, /^(?:SessionHeader|JsonlHeaderLine|SessionEventEnvelope|event:.+)$/u, 'changed root')
    if (roots.has(root)) throw new Error(`${release.tag}: duplicate change for ${root}`)
    roots.add(root)
    for (const field of ['before', 'after']) if (change[field] !== null) string(change[field], DIGEST_PATTERN, `${release.tag} ${field} digest`)
  }
  return input as unknown as PersistenceReleaseRecord
}

function validateTypes(snapshot: PersistenceSchemaInventory, tag: string): void {
  const reachable = new Set<string>()
  for (const root of snapshot.roots) {
    for (const [index] of root.schema.nodes.entries()) reachable.add(schemaDigest(canonicalizeSchema(root.schema.nodes, index)))
  }
  const listed = new Set<string>()
  for (const type of snapshot.types) {
    if (listed.has(type.digest)) throw new Error(`${tag}: duplicate schema type ${type.digest}`)
    listed.add(type.digest)
    if (!reachable.has(type.digest)) throw new Error(`${tag}: unreferenced schema type ${type.digest}`)
  }
  if (listed.size !== reachable.size) throw new Error(`${tag}: schema types must cover every reachable type`)
}

function validateVersion(roots: ReadonlyMap<string, PersistenceRoot>, release: PersistenceRelease): void {
  for (const key of ['SessionHeader', 'JsonlHeaderLine', 'SessionEventEnvelope']) {
    if (!roots.has(key)) throw new Error(`${release.tag}: reconstructed state is missing ${key}`)
  }
  const header = roots.get('SessionHeader') as PersistenceRoot
  const node = header.schema.nodes[0]
  const field = node?.kind === 'object' ? node.properties.find(property => property.name === 'version') : undefined
  const value = field === undefined ? undefined : header.schema.nodes[field.type]
  if (field?.optional !== false || !(value?.kind === 'primitive' && value.type === 'number'
    || value?.kind === 'literal' && value.value === release.sessionFormatVersion)) {
    throw new Error(`${release.tag}: SessionHeader.version does not match the recorded format version`)
  }
}

/** Read and validate every pinned prerelease and reconstruct adjacent type changes.
 * @param root - repository directory containing the committed release archive.
 * @returns verified records and informational classifications, without enforcing modern version-bump rules.
 */
export function loadPersistenceReleases(root: string): PersistenceReleases {
  const directory = join(root, ARCHIVE_DIRECTORY)
  const manifest = parseManifest(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')))
  const files = new Set(readdirSync(directory))
  const expected = new Set(['manifest.json', 'README.md', 'README.zh.md', 'README.i18n.yaml'])
  for (const filename of expected) if (!files.has(filename)) throw new Error(`missing release artifact ${filename}`)
  for (const release of manifest.releases) {
    for (const suffix of ['.md', '.zh.md', '.i18n.yaml', '.schema.json']) {
      const filename = release.tag + suffix
      expected.add(filename)
      if (!files.has(filename)) throw new Error(`${release.tag}: missing release artifact ${filename}`)
    }
  }
  for (const file of files) if (!expected.has(file)) throw new Error(`unreferenced persistence release artifact: ${file}`)
  const entries: PersistenceReleaseEntry[] = []
  const roots = new Map<string, PersistenceRoot>()
  for (const release of manifest.releases) {
    const read = (suffix: string): string => readFileSync(join(directory, release.tag + suffix), 'utf8').replaceAll('\r\n', '\n')
    const english = machineBlock(read('.md'), `${release.tag}.md`)
    const chinese = machineBlock(read('.zh.md'), `${release.tag}.zh.md`)
    if (english !== chinese) throw new Error(`${release.tag}: bilingual machine records differ`)
    const record = parseRecord(english, release, entries.at(-1)?.release.tag ?? null)
    const snapshot = parseHistoricalPersistenceSnapshot(JSON.parse(read('.schema.json')))
    validateTypes(snapshot, release.tag)
    const afterRoots = new Map(snapshot.roots.map(root => [root.key, root]))
    const expectedRoots = record.changes.filter(change => change.after !== null).map(change => change.root).sort()
    if (JSON.stringify([...afterRoots.keys()].sort()) !== JSON.stringify(expectedRoots)) throw new Error(`${release.tag}: snapshot roots do not match changed after schemas`)
    const differences: (PersistenceTypeChange & { readonly root: string })[] = []
    for (const change of record.changes) {
      const before = roots.get(change.root) ?? null
      const after = afterRoots.get(change.root) ?? null
      if (change.before !== (before?.digest ?? null)) throw new Error(`${release.tag}: before digest mismatch for ${change.root}`)
      if (change.after !== (after?.digest ?? null)) throw new Error(`${release.tag}: after digest mismatch for ${change.root}`)
      const changes = classifyPersistenceChange(before, after)
      if (changes.length === 0) throw new Error(`${release.tag}: unchanged transition for ${change.root}`)
      differences.push(...changes.map(value => ({ ...value, root: change.root })))
      if (after === null) roots.delete(change.root)
      else roots.set(change.root, after)
    }
    validateVersion(roots, release)
    entries.push({ release, record, snapshot, roots: new Map(roots), differences })
  }
  return { manifest, entries }
}

/** Validate the archive and check or refresh its bounded factual Markdown regions.
 * @param args - CLI arguments; --write refreshes facts and pairing sidecars after complete validation.
 * @param root - default repository directory, overridden by --root when provided.
 * @returns the verified release counts and optional number of refreshed artifacts.
 */
export function runPersistenceReleases(args: readonly string[], root = resolve(import.meta.dirname, '..')): string {
  const { values } = parseArgs({ args: [...args], options: { root: { type: 'string' }, write: { type: 'boolean' } } })
  root = resolve(values.root ?? root)
  const archive = loadPersistenceReleases(root)
  const artifacts = persistenceReleaseFactArtifacts(root, archive)
  const changed = artifacts.filter(artifact => readFileSync(join(root, artifact.path), 'utf8') !== artifact.content)
  const stale = changed.filter(artifact => artifact.path.endsWith('.md'))
  if (!values.write && stale.length > 0) throw new Error(`Stale persistence release facts: ${stale.map(file => file.path).join(', ')}. Run pnpm run verify-persistence-releases --write.`)
  if (values.write) for (const artifact of changed) writeFileSync(join(root, artifact.path), artifact.content)
  return `Persistence release archive: ${archive.entries.length} records, ${archive.entries.length - 1} adjacent transitions verified.`
    + (values.write ? ` Refreshed ${changed.length} file${changed.length === 1 ? '' : 's'}.` : '')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    console.log(runPersistenceReleases(process.argv.slice(2)))
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
