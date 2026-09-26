/**
 * Enforce complete English/Chinese pairs, matching structure, and recorded
 * per-section hashes for every in-scope document. The manifest contains only explicit
 * exclusions, which may have neither a counterpart nor a sidecar.
 * `--list` reports state; `--write <pairs...>` records the named confirmed
 * pairs (`--write --all` records every complete pair); `--cached <pairs...>`
 * checks exact index bytes for hooks. A check or write named with pair paths
 * touches only those pairs, so update iteration does not pay for a corpus
 * scan. Translation quality remains a review responsibility.
 * See `docs/i18n/README.md` for the owning contract.
 */

import { existsSync, globSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { gitIndexPaths, readGitIndexBlob } from './translation-pairing-git.ts'
import {
  computeTranslationPairingRecord,
  parseTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairingRecordDiff,
  translationPairPaths,
} from './translation-pairing-record.ts'
import {
  languageSwitcherTargets,
  parseTranslationMarkdown,
  parseTranslationPairingCliArgs,
  parseTranslationPairingManifest,
  generatedRegions,
  requiresSourceLanguageSwitcher,
  isTranslationPairingManifestExcluded,
  isTranslationScopeFile,
  TRANSLATION_SCOPE_GLOB_EXCLUDES,
  translationPairSourcePredicate,
  translationStructureDiff,
  translationStructureSignature,
} from './translation-pairing.ts'
import {
  hasLanguageSwitcher,
  normalizeTranslationMarkdownLinks,
  translationLinkLocaleViolations,
} from './translation-links.ts'

const root = resolve(import.meta.dirname, '..')
let request: ReturnType<typeof parseTranslationPairingCliArgs>
try {
  request = parseTranslationPairingCliArgs(process.argv.slice(2))
} catch (error) {
  console.error(`verify-translation-pairing: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
const listMode = request.mode === 'list'
const writeMode = request.mode === 'write'
const indexMode = request.input === 'index'
const indexFiles = indexMode ? gitIndexPaths(root) : undefined

const contentCache = new Map<string, Buffer | undefined>()

/** Read one repository path from the selected worktree or index plane. */
function readRepositoryFile(file: string): Buffer | undefined {
  if (contentCache.has(file)) return contentCache.get(file)
  const content = indexMode
    ? indexFiles?.has(file) ? readGitIndexBlob(root, file) : undefined
    : existsSync(join(root, file)) && statSync(join(root, file)).isFile()
      ? readFileSync(join(root, file))
      : undefined
  contentCache.set(file, content)
  return content
}

/** Whether one path exists in the selected content plane. */
function repositoryFileExists(file: string): boolean {
  return indexMode ? indexFiles?.has(file) === true : readRepositoryFile(file) !== undefined
}

/** Discover source Markdown and pairing sidecars before applying the corpus predicate. */
const SCOPE_PATTERNS = [
  '**/*.md',
  '**/*.i18n.yaml',
  '.agents/notes/**/*.md',
  '.agents/notes/**/*.i18n.yaml',
]

const manifestContent = readRepositoryFile('scripts/translation-pairing.manifest.json')
if (manifestContent === undefined) {
  throw new Error('scripts/translation-pairing.manifest.json is missing from the selected content plane')
}
const manifest = parseTranslationPairingManifest(manifestContent.toString('utf8'))
const isTranslationPairSource = translationPairSourcePredicate(manifest)

/**
 * An excluded entry ending in `/` excludes the whole directory. The trailing
 * slash IS the path boundary — `docs/tool-catalog/` cannot prefix-match a
 * sibling like `docs/tool-catalog-notes/x.md` — so directory entries in the
 * manifest must keep their trailing slash.
 */
function isExcluded(file: string): boolean {
  return isTranslationPairingManifestExcluded(file, manifest)
}

const recordContext = { repoRoot: root, isTranslationPairSource, repositoryFileExists }

// Enumerate the scope once: the whole corpus, or exactly the named pairs'
// three files (a named pair whose files are absent is caught by the same
// completeness rules that cover discovered remnants).
const files = new Set<string>()
if (request.scope === 'pairs') {
  for (const anchor of request.anchors) {
    const { source, zh, meta } = translationPairPaths(anchor)
    for (const file of [source, zh, meta]) {
      if (repositoryFileExists(file)) files.add(file)
    }
    // A named worktree anchor with no files still enters the source list so
    // an interactive check reports it. An index check accepts a complete
    // three-file deletion and still rejects every partial deletion below.
    if (!indexMode && !repositoryFileExists(anchor)) files.add(anchor)
  }
} else {
  for (const pattern of SCOPE_PATTERNS) {
    for (const match of globSync(pattern, { cwd: root, exclude: TRANSLATION_SCOPE_GLOB_EXCLUDES })) {
      const normalized = match.split(sep).join('/')
      if (isTranslationScopeFile(normalized)) files.add(normalized)
    }
  }
}
const translations = [...files].filter(f => f.endsWith('.zh.md')).sort()
const metas = [...files].filter(f => f.endsWith('.i18n.yaml')).sort()
const sources = [...files].filter(f => f.endsWith('.md') && !f.endsWith('.zh.md')).sort()

if (request.scope === 'pairs') {
  const rejected = request.anchors.filter(anchor => !isTranslationScopeFile(anchor) || isExcluded(anchor))
  const absent = request.anchors.filter((anchor) => {
    const { source, zh, meta } = translationPairPaths(anchor)
    return ![source, zh, meta].some(repositoryFileExists)
  })
  if (rejected.length > 0 || (!indexMode && absent.length > 0)) {
    for (const anchor of rejected) {
      console.error(`verify-translation-pairing: ${anchor} is not an in-scope pair (excluded or outside the documentation corpus; see docs/i18n/README.md)`)
    }
    for (const anchor of absent) {
      console.error(`verify-translation-pairing: ${anchor} names no pair on disk (none of its three files exist)`)
    }
    process.exit(2)
  }
}

// --write: (re)record the section hashes for the requested complete pairs, creating
// missing records. A named pair that cannot be recorded (missing counterpart)
// fails loud; corpus scope (--all) skips pairless sources as before.
if (writeMode) {
  let written = 0
  for (const source of sources) {
    if (isExcluded(source)) continue
    const paths = translationPairPaths(source)
    const { zh, meta } = paths
    if (!repositoryFileExists(source) || !repositoryFileExists(zh)) {
      if (request.scope === 'pairs') {
        console.error(`verify-translation-pairing: cannot record ${source}: missing ${repositoryFileExists(source) ? zh : source}`)
        process.exit(2)
      }
      continue
    }
    const sourceContent = readRepositoryFile(source)
    const zhContent = readRepositoryFile(zh)
    if (sourceContent === undefined || zhContent === undefined) throw new Error(`${source}: complete pair became unreadable`)
    let record: string
    try {
      record = renderTranslationPairingRecord(paths, computeTranslationPairingRecord(
        paths,
        sourceContent.toString('utf8'),
        zhContent.toString('utf8'),
        recordContext,
      ))
    } catch (error) {
      console.error(`verify-translation-pairing: cannot record ${source}: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
    if (existsSync(join(root, meta)) && readFileSync(join(root, meta), 'utf8') === record) continue
    writeFileSync(join(root, meta), record)
    console.log(`verify-translation-pairing: recorded ${meta}`)
    written++
  }
  console.log(`verify-translation-pairing: ${written} record(s) written; run the check to validate the pairs.`)
  process.exit(0)
}

const errors: string[] = []
const state = new Map<string, 'ok' | 'out-of-sync' | 'missing'>()

// 1. Every discovered, non-excluded source merges bilingual.
for (const source of sources) {
  if (isExcluded(source)) continue
  const { zh } = translationPairPaths(source)
  if (!repositoryFileExists(zh)) {
    errors.push(`${source}: in-scope documentation must merge bilingual (docs/i18n/README.md); add the counterpart and record the pair`)
    state.set(source, 'missing')
  }
}

// 2. Every pair that exists at all is complete and consistent. Anchor on the
// union of .zh.md files and .i18n.yaml records so a half-deleted pair is
// caught from either remnant.
const pairAnchors = new Set<string>()
for (const zh of translations) pairAnchors.add(zh.replace(/\.zh\.md$/, '.md'))
for (const meta of metas) pairAnchors.add(meta.replace(/\.i18n\.yaml$/, '.md'))

for (const source of [...pairAnchors].sort()) {
  const paths = translationPairPaths(source)
  const { zh, meta } = paths
  const have = {
    source: repositoryFileExists(source),
    zh: repositoryFileExists(zh),
    meta: repositoryFileExists(meta),
  }

  if (isExcluded(source)) {
    if (have.zh) errors.push(`${zh}: ${source} is excluded from pairing (generated or bilingual-by-construction); this translation must not exist`)
    if (have.meta) errors.push(`${meta}: ${source} is excluded from pairing; this consistency record must not exist`)
    continue
  }
  const missing = Object.entries(have).filter(([, ok]) => !ok).map(([k]) => (k === 'source' ? source : k === 'zh' ? zh : meta))
  if (missing.length > 0) {
    errors.push(`${source}: incomplete pair — missing ${missing.join(', ')} (pairs merge whole: both languages plus the .i18n.yaml record)`)
    continue
  }

  const sourceContent = readRepositoryFile(source)
  const zhContent = readRepositoryFile(zh)
  const metaContent = readRepositoryFile(meta)
  if (sourceContent === undefined || zhContent === undefined || metaContent === undefined) {
    throw new Error(`${source}: complete pair became unreadable`)
  }
  const record = parseTranslationPairingRecord(metaContent.toString('utf8'))
  if (record === undefined) {
    errors.push(`${meta}: malformed consistency record (expected \`/<section path>:\` entries, each followed by \`  en: <16-hex>\` and \`  zh: <16-hex>\`)`)
    state.set(source, 'out-of-sync')
    continue
  }

  const sourceText = sourceContent.toString('utf8')
  const zhText = zhContent.toString('utf8')
  let current: ReturnType<typeof computeTranslationPairingRecord>
  try {
    current = computeTranslationPairingRecord(paths, sourceText, zhText, recordContext)
  } catch (error) {
    errors.push(`${source} ↔ ${zh}: ${error instanceof Error ? error.message : String(error)}`)
    state.set(source, 'out-of-sync')
    continue
  }
  const recordErrors = translationPairingRecordDiff(record, current).map(message => (
    `${meta}: out of sync — ${message} (bring the other side along, then re-record with --write)`
  ))
  if (recordErrors.length === 0 && renderTranslationPairingRecord(paths, current) !== metaContent.toString('utf8')) {
    recordErrors.push(`${meta}: not in canonical form (re-record with --write)`)
  }
  if (recordErrors.length > 0) {
    errors.push(...recordErrors)
    state.set(source, 'out-of-sync')
    continue
  }
  const sourceSwitcherTargets = languageSwitcherTargets(source)
  const zhSwitcherTargets = languageSwitcherTargets(zh)
  for (const violation of [
    ...translationLinkLocaleViolations(sourceText, {
      repoRoot: root,
      sourcePath: source,
      isTranslationPairSource,
      repositoryFileExists,
    }, zhSwitcherTargets),
    ...translationLinkLocaleViolations(zhText, {
      repoRoot: root,
      sourcePath: zh,
      isTranslationPairSource,
      repositoryFileExists,
    }, sourceSwitcherTargets),
  ]) {
    errors.push(`${violation.sourcePath}:${violation.line}: link target ${JSON.stringify(violation.url)} uses the wrong locale; expected ${JSON.stringify(violation.expectedUrl)}`)
    state.set(source, 'out-of-sync')
  }

  // Generated regions must remain byte-identical after paired document paths
  // are normalized to one semantic target. The structural signature below
  // compares their contents again as part of the whole document; this named
  // check rejects any prose, ordering, code, marker, or non-locale URL drift.
  let sourceRegions: string[]
  let zhRegions: string[]
  try {
    sourceRegions = generatedRegions(sourceText).map(region => region.text)
    zhRegions = generatedRegions(zhText).map(region => region.text)
  } catch (error) {
    errors.push(`${source} ↔ ${zh}: ${error instanceof Error ? error.message : String(error)}`)
    state.set(source, 'out-of-sync')
    continue
  }
  const normalizedSourceRegions = sourceRegions.map(region => normalizeTranslationMarkdownLinks(region, {
    repoRoot: root,
    sourcePath: source,
    isTranslationPairSource,
    repositoryFileExists,
  }))
  const normalizedZhRegions = zhRegions.map(region => normalizeTranslationMarkdownLinks(region, {
    repoRoot: root,
    sourcePath: zh,
    isTranslationPairSource,
    repositoryFileExists,
  }))
  if (normalizedSourceRegions.length !== normalizedZhRegions.length
    || normalizedSourceRegions.some((region, index) => region !== normalizedZhRegions[index])) {
    errors.push(`${source} ↔ ${zh}: generated regions differ beyond paired-document locale paths — regenerate both sides`)
    state.set(source, 'out-of-sync')
  }

  const sourceTree = parseTranslationMarkdown(sourceText)
  const zhTree = parseTranslationMarkdown(zhText)
  if (!hasLanguageSwitcher(zhTree, zhText, sourceSwitcherTargets)) {
    errors.push(`${zh}: missing language switcher — no link to ${basename(source)}`)
  }
  if (requiresSourceLanguageSwitcher(source) && !hasLanguageSwitcher(sourceTree, sourceText, zhSwitcherTargets)) {
    errors.push(`${source}: missing language switcher — no link back to ${basename(zh)}`)
  }
  for (const divergence of translationStructureDiff(
    translationStructureSignature(sourceTree, zhSwitcherTargets, {
      repoRoot: root,
      sourcePath: source,
      isTranslationPairSource,
      repositoryFileExists,
      markdown: sourceText,
    }),
    translationStructureSignature(zhTree, sourceSwitcherTargets, {
      repoRoot: root,
      sourcePath: zh,
      isTranslationPairSource,
      repositoryFileExists,
      markdown: zhText,
    }),
  )) {
    errors.push(`${source} ↔ ${zh}: ${divergence}`)
  }
  if (!state.has(source)) state.set(source, 'ok')
}

// Complete the state map for --list: any in-scope, non-excluded document with no pair is missing.
for (const source of sources) {
  if (!isExcluded(source) && !state.has(source)) state.set(source, 'missing')
}

if (listMode) {
  const order = { 'out-of-sync': 0, missing: 1, ok: 2 } as const
  const rows = [...state.entries()].sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]))
  for (const [file, status] of rows) {
    console.log(`${status.padEnd(11)} ${file}${status === 'missing' ? '  (required)' : ''}`)
  }
  const counts = { 'ok': 0, 'out-of-sync': 0, 'missing': 0 }
  for (const status of state.values()) counts[status]++
  console.log(`verify-translation-pairing: ${counts.ok} ok, ${counts['out-of-sync']} out-of-sync, ${counts.missing} missing (of ${state.size} in scope)`)
  process.exit(0)
}

if (errors.length === 0) {
  console.log(request.scope === 'pairs'
    ? `verify-translation-pairing: ${pairAnchors.size} named ${indexMode ? 'staged ' : ''}pair(s) consistent; the corpus-wide check still runs in doc-sync.`
    : `verify-translation-pairing: ${pairAnchors.size} pair(s) checked across all in-scope documentation, all consistent.`)
  process.exit(0)
}

console.error('verify-translation-pairing: bilingual pairing rules violated (see docs/i18n/README.md):')
for (const message of errors) console.error(`  ${message}`)
process.exit(1)
