/**
 * Print the minimal-update briefing for out-of-sync translation pairs:
 * `pnpm run gen-translation-brief [--apply] [pair paths...]`. With no
 * arguments it discovers every out-of-sync pair; with arguments (any file
 * of a pair) it briefs exactly those pairs and fails loud on in-sync,
 * incomplete, or out-of-scope requests. Each briefing maps the change at
 * the narrowest safe granularity — code-fence-only splice, changed
 * Markdown units, heading sections, whole document — and `--apply` writes
 * the computed counterpart for pairs whose change is code-fence-only.
 * The briefing rules live in `scripts/translation-brief.ts`; the
 * consuming workflow is `.agents/skills/dsh-translate-docs/SKILL.md`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import {
  isTranslationPairingManifestExcluded,
  isTranslationScopeFile,
  pairAnchorOfArgument,
  parseTranslationMarkdown,
  parseTranslationPairingManifest,
  TRANSLATION_SCOPE_GLOB_EXCLUDES,
  translationPairSourcePredicate,
  translationStructureDiff,
  translationStructureSignature,
} from './translation-pairing.ts'
import {
  computeTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairPaths,
} from './translation-pairing-record.ts'
import {
  changedSpanIndices,
  computeMechanicalUpdate,
  firstOccurrenceContext,
  markdownUnits,
  relevantTerminologyRows,
  renderTranslationBrief,
  sectionSpans,
  spansAligned,
  type BriefBundle,
  type BriefDirection,
  type BriefScope,
  type MarkdownSpan,
} from './translation-brief.ts'

const root = resolve(import.meta.dirname, '..')
const manifest = parseTranslationPairingManifest(readFileSync(join(root, 'scripts/translation-pairing.manifest.json'), 'utf8'))
const isTranslationPairSource = translationPairSourcePredicate(manifest)
const terminology = readFileSync(join(root, 'docs/i18n/terminology.md'), 'utf8')

function isExcluded(file: string): boolean {
  return isTranslationPairingManifestExcluded(file, manifest)
}

function git(args: string[], allowedExitCodes: number[] = [0]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (result.error) throw result.error
  if (!allowedExitCodes.includes(result.status ?? -1)) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

/** Render the record for one pair's contents, or `undefined` when its headings do not align. */
function recordOf(anchor: string, en: string, zh: string): string | undefined {
  const paths = translationPairPaths(anchor)
  try {
    return renderTranslationPairingRecord(paths, computeTranslationPairingRecord(paths, en, zh, {
      repoRoot: root,
      isTranslationPairSource,
    }))
  } catch {
    // A heading-count mismatch, the only computation error, means these contents were never confirmed.
    return undefined
  }
}

/** Both sides at the newest commit whose contents produce the confirmed record. */
function lastConfirmed(anchor: string, zh: string, record: string): { en: string; zh: string } | undefined {
  for (const commit of git(['log', '--format=%H', '--', anchor, zh]).split('\n').filter(Boolean)) {
    const en = git(['show', `${commit}:${anchor}`], [0, 128])
    const zhText = git(['show', `${commit}:${zh}`], [0, 128])
    if (en !== '' && zhText !== '' && recordOf(anchor, en, zhText) === record) return { en, zh: zhText }
  }
  return undefined
}

/** Unified diff between two texts, headers stripped, via `git diff --no-index`. */
function diffTexts(before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'translation-brief-'))
  try {
    writeFileSync(join(dir, 'last-confirmed.md'), before)
    writeFileSync(join(dir, 'current.md'), after)
    const raw = git(['diff', '--no-index', '--unified=2', join(dir, 'last-confirmed.md'), join(dir, 'current.md')], [0, 1])
    return raw.split('\n')
      .filter(line => !line.startsWith('diff --git') && !line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ '))
      .join('\n')
      .trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface PairState {
  anchor: string
  zh: string
  meta: string
  enDrifted: boolean
  zhDrifted: boolean
  enLast: string
  zhLast: string
}

/** Load one pair's recorded and current state, or explain why it cannot be briefed. */
function loadPair(anchor: string): PairState | string {
  const zh = anchor.replace(/\.md$/, '.zh.md')
  const meta = anchor.replace(/\.md$/, '.i18n.yaml')
  if (!isTranslationScopeFile(anchor) || isExcluded(anchor)) {
    return `${anchor}: not an in-scope documentation pair (docs/i18n/README.md)`
  }
  const missing = [anchor, zh, meta].filter(file => !existsSync(join(root, file)))
  if (missing.length > 0) {
    return `${anchor}: incomplete pair (missing ${missing.join(', ')}) — a new counterpart is whole-document translation work, not a minimal update`
  }
  const record = readFileSync(join(root, meta), 'utf8')
  const enCurrent = readFileSync(join(root, anchor), 'utf8')
  const zhCurrent = readFileSync(join(root, zh), 'utf8')
  if (recordOf(anchor, enCurrent, zhCurrent) === record) {
    return { anchor, zh, meta, enDrifted: false, zhDrifted: false, enLast: enCurrent, zhLast: zhCurrent }
  }
  const confirmed = lastConfirmed(anchor, zh, record)
  if (confirmed === undefined) {
    return `${meta}: no commit of the pair produces this record — commit the confirmed pair before briefing its later edits`
  }
  const enLast = confirmed.en
  const zhLast = confirmed.zh
  return {
    anchor,
    zh,
    meta,
    enDrifted: enCurrent !== enLast,
    zhDrifted: zhCurrent !== zhLast,
    enLast,
    zhLast,
  }
}

/** Assemble bundles for the given changed + first-occurrence span indices. */
function bundlesFor(
  indices: number[],
  extraIndices: number[],
  confirmed: MarkdownSpan[],
  current: MarkdownSpan[],
  counterpart: MarkdownSpan[],
): BriefBundle[] {
  const extras = new Set(extraIndices)
  return [...new Set([...indices, ...extraIndices])].sort((left, right) => left - right).map((index) => {
    const confirmedSpan = confirmed[index]
    const currentSpan = current[index]
    const counterpartSpan = counterpart[index]
    if (confirmedSpan === undefined || currentSpan === undefined || counterpartSpan === undefined) {
      throw new Error(`gen-translation-brief: span ${index} is unmapped despite alignment`)
    }
    return {
      index,
      label: currentSpan.label,
      reason: extras.has(index) && confirmedSpan.text === currentSpan.text ? 'first-occurrence' as const : undefined,
      confirmedSourceText: confirmedSpan.text,
      currentSourceText: currentSpan.text,
      counterpartText: counterpartSpan.text,
      counterpartStartLine: counterpartSpan.startLine,
    }
  })
}

interface PlannedBrief {
  scope: BriefScope
  /** Old + new text of the changed spans, for terminology matching. */
  changedText: string
  /** Computed counterpart for a mechanical scope, for `--apply`. */
  mechanicalResult?: string | undefined
}

/** Choose the narrowest safely mapped granularity for one drifted side. */
function planScope(
  sourceLast: string,
  sourceCurrent: string,
  counterpartCurrent: string,
  direction: BriefDirection,
  bothDrifted: boolean,
): PlannedBrief {
  const wholeChangedText = `${sourceLast}\n${sourceCurrent}`
  if (bothDrifted) {
    return {
      scope: { kind: 'document', reason: 'BOTH sides changed since the pair was last confirmed consistent, so no side is a trustworthy mapping anchor; decide which side owns each divergence.' },
      changedText: wholeChangedText,
    }
  }
  const mechanical = computeMechanicalUpdate(sourceLast, sourceCurrent, counterpartCurrent)
  if (mechanical !== undefined) {
    return { scope: { kind: 'mechanical' }, changedText: wholeChangedText, mechanicalResult: mechanical }
  }
  for (const [kind, spansOf] of [['units', markdownUnits], ['sections', sectionSpans]] as const) {
    const confirmed = spansOf(sourceLast)
    const current = spansOf(sourceCurrent)
    const counterpart = spansOf(counterpartCurrent)
    if (!spansAligned(confirmed, current) || !spansAligned(confirmed, counterpart)) continue
    const changed = changedSpanIndices(confirmed, current)
    if (changed.length === 0) continue
    const changedText = changed.map(index => `${confirmed[index]?.text ?? ''}\n${current[index]?.text ?? ''}`).join('\n')
    const rows = relevantTerminologyRows(terminology, direction, changedText)
    const occurrence = direction === 'en-to-zh'
      ? firstOccurrenceContext(sourceLast, sourceCurrent, confirmed, current, rows, new Set(changed))
      : { notes: [], extraSpanIndices: [] }
    return {
      scope: {
        kind,
        bundles: bundlesFor(changed, occurrence.extraSpanIndices, confirmed, current, counterpart),
        firstOccurrenceNotes: occurrence.notes,
      },
      changedText,
    }
  }
  return {
    scope: { kind: 'document', reason: 'Neither fine-grained units nor heading sections align one to one across the last-confirmed source, current source, and current counterpart.' },
    changedText: wholeChangedText,
  }
}

/** Validate a computed mechanical counterpart and write it. */
function applyMechanical(counterpartPath: string, sourceCurrent: string, result: string): void {
  const counterpartBase = basename(counterpartPath)
  const sourcePath = counterpartPath.endsWith('.zh.md')
    ? counterpartPath.replace(/\.zh\.md$/, '.md')
    : counterpartPath.replace(/\.md$/, '.zh.md')
  const sourceBase = counterpartBase.endsWith('.zh.md')
    ? counterpartBase.replace(/\.zh\.md$/, '.md')
    : counterpartBase.replace(/\.md$/, '.zh.md')
  const errors = translationStructureDiff(
    translationStructureSignature(
      parseTranslationMarkdown(sourceCurrent),
      counterpartBase,
      { repoRoot: root, sourcePath, isTranslationPairSource, markdown: sourceCurrent },
    ),
    translationStructureSignature(
      parseTranslationMarkdown(result),
      sourceBase,
      { repoRoot: root, sourcePath: counterpartPath, isTranslationPairSource, markdown: result },
    ),
  )
  if (errors.length > 0) {
    throw new Error(`gen-translation-brief: computed mechanical update for ${counterpartPath} violates the pair structure: ${errors.join('; ')}`)
  }
  writeFileSync(join(root, counterpartPath), result)
  console.error(`gen-translation-brief: applied code-fence splice to ${counterpartPath}; review the diff, then record the pair.`)
}

/** Render (and under `--apply`, apply) the briefing for one drifted side. */
function briefDirection(pair: PairState, direction: BriefDirection, apply: boolean): string {
  const sourceIsEnglish = direction === 'en-to-zh'
  const sourcePath = sourceIsEnglish ? pair.anchor : pair.zh
  const counterpartPath = sourceIsEnglish ? pair.zh : pair.anchor
  const sourceLast = sourceIsEnglish ? pair.enLast : pair.zhLast
  const sourceCurrent = readFileSync(join(root, sourcePath), 'utf8')
  const counterpartCurrent = readFileSync(join(root, counterpartPath), 'utf8')
  const diff = diffTexts(sourceLast, sourceCurrent)
  const planned = planScope(sourceLast, sourceCurrent, counterpartCurrent, direction, pair.enDrifted && pair.zhDrifted)
  if (apply && planned.mechanicalResult !== undefined) {
    applyMechanical(counterpartPath, sourceCurrent, planned.mechanicalResult)
  }
  return renderTranslationBrief({
    sourcePath,
    counterpartPath,
    direction,
    diff,
    scope: planned.scope,
    terminology: relevantTerminologyRows(terminology, direction, planned.changedText),
  })
}

const argv = process.argv.slice(2)
const flags = argv.filter(argument => argument.startsWith('--'))
const unknownFlags = flags.filter(flag => flag !== '--apply')
if (unknownFlags.length > 0) {
  console.error(`gen-translation-brief: unknown flag(s): ${unknownFlags.join(', ')} (only --apply is supported)`)
  process.exit(2)
}
const applyMode = flags.includes('--apply')
const requested = argv.filter(argument => !argument.startsWith('--')).map(pairAnchorOfArgument)

let anchors: string[]
if (requested.length > 0) {
  anchors = [...new Set(requested)].sort()
} else {
  const discovered = new Set<string>()
  for (const match of globSync('**/*.i18n.yaml', { cwd: root, exclude: TRANSLATION_SCOPE_GLOB_EXCLUDES })) {
    const normalized = match.split(sep).join('/')
    if (isTranslationScopeFile(normalized)) discovered.add(normalized.replace(/\.i18n\.yaml$/, '.md'))
  }
  anchors = [...discovered].sort()
}

const briefs: string[] = []
const problems: string[] = []
const skipped: string[] = []
for (const anchor of anchors) {
  const pair = loadPair(anchor)
  if (typeof pair === 'string') {
    if (requested.length > 0) problems.push(pair)
    continue
  }
  if (!pair.enDrifted && !pair.zhDrifted) {
    if (requested.length > 0) skipped.push(`${anchor}: pair is consistent with its record — nothing to brief`)
    continue
  }
  if (pair.enDrifted) briefs.push(briefDirection(pair, 'en-to-zh', applyMode))
  if (pair.zhDrifted) briefs.push(briefDirection(pair, 'zh-to-en', applyMode))
}

if (problems.length > 0 || skipped.length > 0) {
  for (const message of [...problems, ...skipped]) console.error(`gen-translation-brief: ${message}`)
  process.exit(2)
}
if (briefs.length === 0) {
  console.log('gen-translation-brief: every recorded pair matches its consistency record; nothing to brief.')
  process.exit(0)
}
console.log(briefs.join('\n\n---\n\n'))
