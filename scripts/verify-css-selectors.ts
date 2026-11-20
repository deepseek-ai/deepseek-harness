/**
 * Reject stylesheet selectors whose matching cost in Chromium grows with the whole document.
 *
 * Blink sorts each rule into a bucket by its subject compound, the compound after the last
 * combinator: an id, class, attribute or type selector, a few pseudo-classes (`:focus`,
 * `:focus-visible`, link states, `:root`, `:host`), some pseudo-elements, or a single-argument
 * `:is()`/`:where()` whose own subject has one of these. A rule without such a key lands in the
 * universal bucket and is tested on every restyled element; an ancestor class or attribute still
 * lets Blink's ancestor filter reject most elements cheaply, but `:not()`, `:empty` and `:has()`
 * cannot be rejected that way and are evaluated in full. The gate therefore rejects:
 *
 * - `unkeyed-costly-subject`: a subject without a bucket key that contains `:not()`, `:empty` or
 *   `:has()`, such as `.row > :not(.nav)` or `:empty:not([class])`. A keyed subject such as
 *   `.reasoning:empty` or `.row:not([hidden])` is accepted.
 * - `global-universal`: a subject without a bucket key whose selector names no class, id or
 *   attribute anywhere, such as `*` or `body *`. Class-scoped forms such as `.card *`,
 *   `.page > *` and `.list > :first-child` are accepted.
 * - `has-outside-subject`: a `:has()` outside the subject compound, such as `.row:has(.x) .child`,
 *   which makes changes inside the anchor's subtree invalidate the anchor's descendants.
 *
 * {@link FRAMEWORK_STYLESHEETS} hold document-wide base styles; only `has-outside-subject` applies
 * to them. The corpus is every tracked or non-ignored `.css` file outside `vendor/`; CSS Modules
 * `:global()`/`:local()` wrappers are transparent. Styles embedded in TypeScript strings are out of
 * scope. A rule that must keep a rejected selector states why in a comment that ends on the line
 * directly above the rule and starts with `css-selector-gate:`; an exception comment that no
 * longer precedes a rejected rule is itself a finding. Nested CSS is rejected because the gate
 * does not resolve `&`.
 *
 * Existing selectors are recorded in `scripts/css-selectors.baseline.json` by file, defect and
 * serialized selector, with the number of occurrences. A finding beyond its recorded count fails;
 * a recorded occurrence that no longer exists also fails until `--prune` removes it, so the list
 * only shrinks.
 */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transform, type Selector, type SelectorComponent } from 'lightningcss'

const GATE = 'verify-css-selectors'
const root = resolve(import.meta.dirname, '..')

/** Comment prefix that records why a rule keeps a rejected selector. */
export const EXCEPTION_PREFIX = 'css-selector-gate:'

/** Why a selector is rejected. */
export type CssSelectorDefect = 'unkeyed-costly-subject' | 'global-universal' | 'has-outside-subject' | 'nesting' | 'stale-exception'

/** One rejected selector or stale exception comment. */
export interface CssSelectorFinding {
  /** Repository-relative path with forward slashes. */
  file: string
  /** One-based line of the rule's selector list, or of the stale comment. */
  line: number
  defect: CssSelectorDefect
  /** Serialized selector, or the comment text for a stale exception. */
  selector: string
}

/**
 * Repository-relative paths, or directory prefixes ending in `/`, of document-wide base and framework
 * stylesheets. Each entry must match at least one scanned stylesheet.
 */
export const FRAMEWORK_STYLESHEETS: readonly string[] = [
  'apps/desktop/renderer/',
  'packages/client/ui-theme/src/styles/',
  'packages/client/web/src/base.css',
]

/**
 * Whether a stylesheet holds document-wide base styles.
 * @param file - repository-relative path with forward slashes.
 * @returns `true` when {@link FRAMEWORK_STYLESHEETS} names the file or a prefix of it.
 */
export function isFrameworkStylesheet(file: string): boolean {
  return FRAMEWORK_STYLESHEETS.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry)
}

/** Pseudo-classes that give a compound its own Blink bucket. */
const BUCKETED_PSEUDO_CLASSES = new Set(['focus', 'focus-visible', 'link', 'visited', 'any-link', 'root', 'host', 'active-view-transition'])

/**
 * Pseudo-elements Blink buckets by their own name; `::-webkit-scrollbar` itself is not one of them,
 * only its parts are.
 */
const BUCKETED_PSEUDO_ELEMENTS = new Set(['placeholder', 'file-selector-button', 'details-content', 'part', 'slotted', 'cue', 'custom'])
const BUCKETED_SCROLLBAR_PARTS = new Set(['button', 'corner', 'thumb', 'track', 'track-piece'])

function unwrapModules(selector: Selector): SelectorComponent[] {
  const out: SelectorComponent[] = []
  for (const component of selector) {
    if (component.type === 'pseudo-class' && (component.kind === 'global' || component.kind === 'local')) {
      out.push(...unwrapModules(component.selector))
    } else {
      out.push(component)
    }
  }
  return out
}

function compounds(selector: Selector): SelectorComponent[][] {
  let current: SelectorComponent[] = []
  const out = [current]
  for (const component of unwrapModules(selector)) {
    if (component.type === 'combinator') out.push(current = [])
    else current.push(component)
  }
  return out
}

function subject(selector: Selector): SelectorComponent[] {
  return compounds(selector).at(-1) ?? []
}

/**
 * Whether Blink places a compound in a bucket other than the universal one.
 * @param compound - simple selectors of one compound, in source order.
 * @returns `true` when a component before any non-bucketing pseudo-element supplies a key.
 */
function isBucketed(compound: readonly SelectorComponent[]): boolean {
  for (const component of compound) {
    switch (component.type) {
      case 'id':
      case 'class':
      case 'type':
      case 'attribute':
        return true
      case 'pseudo-class':
        if (BUCKETED_PSEUDO_CLASSES.has(component.kind)) return true
        if ((component.kind === 'is' || component.kind === 'where') && component.selectors.length === 1) {
          const [only] = component.selectors
          if (only !== undefined && isBucketed(subject(only))) return true
        }
        break
      case 'pseudo-element':
        if (BUCKETED_PSEUDO_ELEMENTS.has(component.kind)) return true
        if (component.kind === 'webkit-scrollbar' && BUCKETED_SCROLLBAR_PARTS.has(component.value)) return true
        // Blink stops reading a compound at other pseudo-elements, such as `::before`.
        return false
      default:
        break
    }
  }
  return false
}

function nestedSelectors(component: SelectorComponent): readonly Selector[] {
  if (component.type === 'pseudo-class') {
    switch (component.kind) {
      case 'not':
      case 'is':
      case 'where':
      case 'any':
      case 'has':
        return component.selectors
      case 'host':
        return component.selectors == null ? [] : [component.selectors]
      case 'nth-child':
      case 'nth-last-child':
        return component.of ?? []
      default:
        if ('selector' in component && Array.isArray(component.selector)) return [component.selector]
        return []
    }
  }
  if (component.type === 'pseudo-element' && 'selector' in component && Array.isArray(component.selector)) return [component.selector]
  return []
}

function containsHas(components: readonly SelectorComponent[]): boolean {
  return components.some(component => (component.type === 'pseudo-class' && component.kind === 'has')
    || nestedSelectors(component).some(containsHas))
}

/** Pseudo-classes Blink evaluates in full on every candidate element. */
const COSTLY_PSEUDO_CLASSES = new Set(['not', 'empty', 'has'])

/**
 * Whether a subject compound matches through `:not()`, `:empty` or `:has()`, directly or through the
 * subject compound of an `:is()`, `:where()` or `:nth-*(… of …)` argument.
 * @param compound - simple selectors of a subject compound.
 * @returns `true` when such a pseudo-class decides the match.
 */
function containsCostlyPseudo(compound: readonly SelectorComponent[]): boolean {
  return compound.some(component => (component.type === 'pseudo-class' && COSTLY_PSEUDO_CLASSES.has(component.kind))
    || (component.type === 'pseudo-class' && nestedSelectors(component).some(argument => containsCostlyPseudo(subject(argument)))))
}

/**
 * Whether a selector names a class, id or attribute that scopes its subject: in any compound
 * before the subject, or in an `:is()`/`:where()` argument; `:not()` and `:has()` arguments do not
 * scope the elements a selector matches.
 * @param components - simple selectors and combinators of one complex selector.
 * @returns `true` when such a key exists.
 */
function hasScopingKey(components: readonly SelectorComponent[]): boolean {
  return components.some((component) => {
    if (component.type === 'class' || component.type === 'id' || component.type === 'attribute') return true
    if (component.type === 'pseudo-class' && (component.kind === 'is' || component.kind === 'where')) {
      return component.selectors.every(argument => hasScopingKey(unwrapModules(argument)))
    }
    return false
  })
}

function containsNesting(components: readonly SelectorComponent[]): boolean {
  return components.some(component => component.type === 'nesting' || nestedSelectors(component).some(containsNesting))
}

/**
 * Whether a `:has()` appears in a compound that is not the subject, including inside `:is()`,
 * `:where()` and `:not()` arguments of such compounds and inside the non-subject compounds of
 * arguments of the subject.
 * @param selector - one complex selector.
 * @returns `true` when the selector holds such a `:has()`.
 */
function hasOutsideSubject(selector: Selector): boolean {
  const all = compounds(selector)
  if (all.slice(0, -1).some(containsHas)) return true
  return subject(selector).some(component => !(component.type === 'pseudo-class' && component.kind === 'has')
    && nestedSelectors(component).some(hasOutsideSubject))
}

const ATTRIBUTE_OPERATORS: Record<string, string> = {
  'equal': '=', 'includes': '~=', 'dash-match': '|=', 'prefix': '^=', 'substring': '*=', 'suffix': '$=',
}

function serialize(selector: Selector): string {
  return selector.map((component): string => {
    switch (component.type) {
      case 'combinator':
        return { 'descendant': ' ', 'child': ' > ', 'next-sibling': ' + ', 'later-sibling': ' ~ ' }[component.value as string] ?? ` ${component.value} `
      case 'class': return '.' + component.name
      case 'id': return '#' + component.name
      case 'type': return component.name
      case 'universal': return '*'
      case 'nesting': return '&'
      case 'attribute': {
        const operation = component.operation
        if (operation == null) return '[' + component.name + ']'
        const operator = ATTRIBUTE_OPERATORS[operation.operator] ?? operation.operator
        const flag = operation.caseSensitivity === 'ascii-case-insensitive' ? ' i' : operation.caseSensitivity === 'explicit-case-sensitive' ? ' s' : ''
        return '[' + component.name + operator + JSON.stringify(operation.value) + flag + ']'
      }
      case 'pseudo-class': {
        const inner = nestedSelectors(component)
        if ('a' in component && 'b' in component && typeof component.a === 'number' && typeof component.b === 'number') {
          const step = `${component.a}n${component.b < 0 ? '' : '+'}${component.b}`
          return ':' + component.kind + '(' + step + (inner.length > 0 ? ' of ' + inner.map(serialize).join(', ') : '') + ')'
        }
        return ':' + component.kind + (inner.length > 0 ? '(' + inner.map(serialize).join(', ') + ')' : '')
      }
      case 'pseudo-element': return '::' + component.kind + ('value' in component && typeof component.value === 'string' ? '-' + component.value : '')
      default: return component.type
    }
  }).join('')
}

/** One exception comment: its last line and text. */
interface ExceptionComment {
  line: number
  text: string
}

function exceptionComments(source: string): ExceptionComment[] {
  const comments: ExceptionComment[] = []
  for (const match of source.matchAll(/\/\*([\s\S]*?)\*\//gu)) {
    const text = (match[1] ?? '').trim()
    if (!text.startsWith(EXCEPTION_PREFIX)) continue
    const end = match.index + match[0].length
    comments.push({ line: source.slice(0, end).split('\n').length, text })
  }
  return comments
}

/**
 * Check one stylesheet.
 * @param file - repository-relative path; `.module.css` enables CSS Modules parsing.
 * @param source - stylesheet text.
 * @returns rejected selectors and stale or empty exception comments, in source order.
 * @throws when lightningcss cannot parse the stylesheet; the message names `file`.
 */
export function checkStylesheet(file: string, source: string): CssSelectorFinding[] {
  const rejected: CssSelectorFinding[] = []
  const framework = isFrameworkStylesheet(file)
  try {
    transform({
      filename: file,
      code: Buffer.from(source),
      cssModules: file.endsWith('.module.css'),
      visitor: {
        Rule: {
          style(rule) {
            const line = rule.value.loc.line + 1
            for (const selector of rule.value.selectors) {
              const text = serialize(selector)
              if (containsNesting(selector)) rejected.push({ file, line, defect: 'nesting', selector: text })
              else {
                if (!framework && !isBucketed(subject(selector))) {
                  if (containsCostlyPseudo(subject(selector))) rejected.push({ file, line, defect: 'unkeyed-costly-subject', selector: text })
                  else if (!hasScopingKey(unwrapModules(selector))) rejected.push({ file, line, defect: 'global-universal', selector: text })
                }
                if (hasOutsideSubject(selector)) rejected.push({ file, line, defect: 'has-outside-subject', selector: text })
              }
            }
          },
        },
      },
    })
  } catch (error) {
    throw new Error(`${GATE}: cannot parse stylesheet ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const comments = exceptionComments(source)
  const used = new Set<ExceptionComment>()
  const findings = rejected.filter((finding) => {
    if (finding.defect === 'nesting') return true
    const comment = comments.find(candidate => candidate.line === finding.line - 1)
    if (comment === undefined || comment.text.slice(EXCEPTION_PREFIX.length).trim() === '') return true
    used.add(comment)
    return false
  })
  for (const comment of comments) {
    if (!used.has(comment)) findings.push({ file, line: comment.line, defect: 'stale-exception', selector: comment.text })
  }
  return findings.sort((a, b) => a.line - b.line)
}

/**
 * List the stylesheets the gate scans.
 * @param repoRoot - repository root containing the Git index.
 * @returns sorted repository-relative `.css` paths outside `vendor/`.
 * @throws when discovery finds no Client stylesheet or an eligible path is a symlink.
 */
export function listStylesheets(repoRoot: string): string[] {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).split('\0').map(file => file.replaceAll('\\', '/')).filter(file => file.endsWith('.css') && !file.startsWith('vendor/')))].sort()
  const present = files.filter((file) => {
    const stat = lstatSync(resolve(repoRoot, file), { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error(`${GATE}: stylesheet symlink is unsupported: ${file}`)
    return stat?.isFile() === true
  })
  if (!present.some(file => file.startsWith('packages/client/'))) throw new Error(`${GATE}: stylesheet discovery omitted packages/client/`)
  for (const entry of FRAMEWORK_STYLESHEETS) {
    if (!present.some(file => isFrameworkStylesheet(file) && (entry.endsWith('/') ? file.startsWith(entry) : file === entry))) {
      throw new Error(`${GATE}: framework stylesheet entry matches no stylesheet: ${entry}`)
    }
  }
  return present
}

const MESSAGES: Record<CssSelectorDefect, string> = {
  'unkeyed-costly-subject': 'subject compound has no id, class, attribute or type selector and uses :not(), :empty or :has(), which Chromium evaluates on every restyled element',
  'global-universal': 'selector names no class, id or attribute, so Chromium tests it on every restyled element',
  'has-outside-subject': ':has() outside the subject compound invalidates the anchor subtree on every change inside it',
  'nesting': 'nested CSS is unsupported by this gate; write the rule unnested',
  'stale-exception': `${EXCEPTION_PREFIX} comment does not directly precede a rejected rule`,
}

/** Defects an existing selector may be recorded for. */
const BASELINE_DEFECTS = ['unkeyed-costly-subject', 'global-universal', 'has-outside-subject'] as const
type BaselineDefect = typeof BASELINE_DEFECTS[number]

/** Recorded occurrences: file, then defect, then serialized selector, then count. */
export type CssSelectorBaseline = Record<string, Partial<Record<BaselineDefect, Record<string, number>>>>

/** Repository-relative path of the recorded existing selectors. */
export const BASELINE_PATH = 'scripts/css-selectors.baseline.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBaselineDefect(value: string): value is BaselineDefect {
  return (BASELINE_DEFECTS as readonly string[]).includes(value)
}

/**
 * Validate a parsed baseline.
 * @param value - parsed JSON.
 * @returns the baseline.
 * @throws when an entry is not a positive count under a `.css` path and a recordable defect.
 */
export function parseBaseline(value: unknown): CssSelectorBaseline {
  if (!isRecord(value)) throw new Error(`${GATE}: ${BASELINE_PATH} must be a file-to-defects object`)
  const baseline: CssSelectorBaseline = {}
  for (const [file, defects] of Object.entries(value)) {
    if (!file.endsWith('.css') || file.startsWith('vendor/') || file.startsWith('/') || file.includes('\\')
      || file.split('/').includes('..') || !isRecord(defects) || Object.keys(defects).length === 0) {
      throw new Error(`${GATE}: invalid baseline file: ${file}`)
    }
    const parsed: CssSelectorBaseline[string] = {}
    for (const [defect, selectors] of Object.entries(defects)) {
      if (!isBaselineDefect(defect) || !isRecord(selectors) || Object.keys(selectors).length === 0) {
        throw new Error(`${GATE}: invalid baseline defect: ${file}: ${defect}`)
      }
      const counts: Record<string, number> = {}
      for (const [selector, count] of Object.entries(selectors)) {
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
          throw new Error(`${GATE}: invalid baseline count: ${file}: ${defect}: ${selector}`)
        }
        counts[selector] = count
      }
      parsed[defect] = counts
    }
    baseline[file] = parsed
  }
  return baseline
}

/**
 * Count findings in baseline form.
 * @param findings - findings to record; only recordable defects are counted.
 * @returns the baseline with files, defects and selectors in sorted order.
 */
export function countFindings(findings: readonly CssSelectorFinding[]): CssSelectorBaseline {
  const baseline: CssSelectorBaseline = {}
  for (const { file, defect, selector } of findings) {
    if (!isBaselineDefect(defect)) continue
    const counts = (baseline[file] ??= {})[defect] ??= {}
    counts[selector] = (counts[selector] ?? 0) + 1
  }
  const sorted = <T>(record: Record<string, T>): [string, T][] => Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(sorted(baseline).map(([file, defects]) => [file, Object.fromEntries(
    sorted(defects as Record<string, Record<string, number>>).map(([defect, counts]) => [defect, Object.fromEntries(sorted(counts))]),
  )]))
}

/** Findings beyond the baseline and recorded occurrences that no longer exist. */
export interface BaselineComparison {
  added: CssSelectorFinding[]
  /** `file`, defect, selector and the number of recorded occurrences that are gone. */
  stale: [string, BaselineDefect, string, number][]
}

/**
 * Compare findings with the recorded occurrences.
 * @param findings - current findings.
 * @param baseline - recorded occurrences.
 * @returns new findings, including every non-recordable defect, and retired occurrences.
 */
export function compareBaseline(findings: readonly CssSelectorFinding[], baseline: CssSelectorBaseline): BaselineComparison {
  const remaining = structuredClone(baseline)
  const added: CssSelectorFinding[] = []
  for (const finding of findings) {
    const counts = isBaselineDefect(finding.defect) ? remaining[finding.file]?.[finding.defect] : undefined
    const allowance = counts?.[finding.selector] ?? 0
    if (counts !== undefined && allowance > 0) counts[finding.selector] = allowance - 1
    else added.push(finding)
  }
  const stale: BaselineComparison['stale'] = []
  for (const [file, defects] of Object.entries(remaining)) {
    for (const defect of BASELINE_DEFECTS) {
      for (const [selector, count] of Object.entries(defects[defect] ?? {})) if (count > 0) stale.push([file, defect, selector, count])
    }
  }
  return { added, stale }
}

const REMEDY = `Name the element and state the design means: key the rightmost compound with a class or data/aria attribute the component sets, use a sibling combinator between keyed compounds, or let a parent set a custom property that a keyed child reads (docs/defensive-patterns/client-components.md#keyed-selectors). A rule that cannot be keyed states why in a "/* ${EXCEPTION_PREFIX} <reason> */" comment directly above it.`

/**
 * Verify the repository against the baseline.
 * @param repoRoot - repository root to scan.
 * @param prune - rewrite the baseline without retired occurrences once no new finding exists.
 * @returns the number of recorded occurrences still present.
 * @throws for new findings, a malformed baseline, or retired occurrences without `prune`.
 */
export function verifyCssSelectors(repoRoot: string, prune = false): number {
  const baseline = parseBaseline(JSON.parse(readFileSync(resolve(repoRoot, BASELINE_PATH), 'utf8')))
  const findings = listStylesheets(repoRoot).flatMap(file => checkStylesheet(file, readFileSync(resolve(repoRoot, file), 'utf8')))
  const { added, stale } = compareBaseline(findings, baseline)
  if (added.length > 0) {
    throw new Error(`${GATE}: ${added.length} new finding(s). ${REMEDY}\n`
      + added.map(finding => `  ${finding.file}:${finding.line}: ${finding.selector}\n    ${MESSAGES[finding.defect]}`).join('\n'))
  }
  if (stale.length > 0) {
    if (!prune) {
      throw new Error(`${GATE}: remove retired baseline entries with pnpm run ${GATE} --prune.\n`
        + stale.map(([file, defect, selector, count]) => `  ${file}: ${defect}: ${selector} (${count})`).join('\n'))
    }
    writeFileSync(resolve(repoRoot, BASELINE_PATH), `${JSON.stringify(countFindings(findings), null, 2)}\n`)
  }
  return findings.length
}

/**
 * Run the gate as a command: `--prune` retires stale entries, no argument verifies.
 * @param args - command-line arguments after the script path.
 * @param repoRoot - repository root to scan.
 */
export function main(args: readonly string[], repoRoot: string = root): void {
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--prune')) throw new Error(`Usage: pnpm run ${GATE} [--prune]`)
    const remaining = verifyCssSelectors(repoRoot, args[0] === '--prune')
    console.log(`${GATE}: OK (${remaining} recorded selector occurrence(s) remain)`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main(process.argv.slice(2))
