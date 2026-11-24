/**
 * `runConformance(adapter, mode)`: offline mode conformance check for one adapter mode.
 *
 * Three checks, all offline (normalize → transform → prepare → serialize):
 *
 * 1. **Registered keys render natively.** For every tag (and every variant the mode declares) the mode's registry
 *    claims, a minimal tree is transformed and must not appear in `RenderReport.degraded`. A tag whose container
 *    (`<ul>` for `<li>`, `<table>`/`<tr>` for cells) degrades first cannot be exercised — that is reported as
 *    *skipped*, not as a pass.
 * 2. **Text is conserved.** For every case of the shared corpus ({@link corpusCases}) plus any `options.cases`, each
 *    `text.content` of the input must reappear in the serialized payloads, modulo escaping (adapters escape markdown
 *    metacharacters, so the comparison drops backslashes and squashes whitespace).
 * 3. **The report is complete.** Every element the engine had to lower — an element without a handler, or one whose
 *    variant is not declared — must be listed in `RenderReport.degraded`, so a caller can tell the user what the
 *    platform could not carry.
 *
 * Problems carry the case name (`native:<tag>[.<variant>]` or `corpus:<case>`) and a human message; `ok` is
 * `problems.length === 0`.
 */

import { type Element, type Fragment, normalize, type Tag, variantKey, variantsOf, variantTable } from '@deepseek-ai/satori-element'
import type { Adapter } from '../bot.ts'
import type { RenderReport } from '../fallback.ts'
import type { Mode } from '../mode.ts'
import type { Target } from '../protocol.ts'
import { chosenCandidate } from '../registry.ts'
import { MemoryResourceCache } from '../resource.ts'
import { corpusCases, minimalContent, minimalParents } from './corpus.ts'
import { defaultTarget, renderContent } from './pipeline.ts'

export interface ConformanceOptions {
  target?: Target
  /** Extra corpus cases on top of the shared corpus. */
  cases?: { name: string; content: Fragment }[]
  /** Corpus/native case names to skip, e.g. media on a platform without attachments. */
  skip?: readonly string[]
}

export interface ConformanceProblem {
  case: string
  /** E.g. `text lost: "foo"`, `unexpected fallback: element.pre.lang`, `report misses <table>`. */
  message: string
}

/** A case that could not exercise what it is for (its container degraded, …). */
export interface ConformanceSkip {
  case: string
  reason: string
}

export interface ConformanceResult {
  mode: string
  cases: number
  problems: ConformanceProblem[]
  ok: boolean
  /** Cases that ran out of scope instead of passing; never makes `ok` false. */
  skipped: ConformanceSkip[]
}

/** Tags the engine always renders (a mode without them is a programming error) and envelope/input pseudo-tags. */
const BASE_TAGS: ReadonlySet<Tag> = new Set<Tag>(['text', 'p', 'br'])
const NO_NATIVE_CASE: ReadonlySet<Tag> = new Set<Tag>(['message', 'quote', 'markdown', 'fallback', 'case'])

/**
 * Per registered tag/variant a minimal tree must serialize without fallback in the report; the everything-corpus must
 * conserve text; the report must list every non-native element.
 */
export async function runConformance(
  adapter: Adapter<any, any>,
  mode: string,
  options: ConformanceOptions = {},
): Promise<ConformanceResult> {
  const selected = adapter.modes?.[mode] as Mode<any> | undefined
  if (!selected) {
    throw new Error(`runConformance: adapter "${adapter.id}" has no mode "${mode}" `
      + `(modes: ${Object.keys(adapter.modes ?? {}).join(', ') || 'none'})`)
  }
  const target = options.target ?? defaultTarget(adapter)
  const problems: ConformanceProblem[] = []
  const skipped: ConformanceSkip[] = []
  let cases = 0

  /** Render one case; a throw is a problem of that case, not of the run. */
  const run = async (name: string, content: Fragment) => {
    cases++
    try {
      return await renderContent(adapter, content, { target, mode: selected })
    } catch (error) {
      problems.push({ case: name, message: `render threw: ${describeError(error)}` })
      return undefined
    }
  }

  // 1. Every registered tag and declared variant has to render natively.
  for (const tag of (selected.elements.tags() as Tag[])) {
    const entry = selected.elements.entry(tag)
    if (!entry) {
      // An envelope tag is handed to `assemble` as a root child, so no registry tree can exercise it.
      skipped.push({ case: `native:${tag}`, reason: `<${tag}> goes to the mode envelope, not through the registry` })
      continue
    }
    if (NO_NATIVE_CASE.has(tag)) {
      skipped.push({ case: `native:${tag}`, reason: `<${tag}> never reaches the registry (envelope or input-only tag)` })
      continue
    }
    const declared = (entry.options.variants ?? []).map(String)
    const subjects: (string | undefined)[] = declared.length
      ? declared
      : (variantTable as Record<string, readonly string[]>)[tag] ? [] : [undefined]
    if (!subjects.length) {
      skipped.push({ case: `native:${tag}`, reason: `the mode declares no variant of <${tag}>, so no tree can render it` })
      continue
    }
    const parents = minimalParents(tag)
    for (const variant of subjects) {
      const name = `native:${variant ? `${tag}.${variant}` : tag}`
      let rendered: Awaited<ReturnType<typeof run>>
      try {
        rendered = await run(name, minimalContent(tag, variant))
      } catch (error) {
        problems.push({ case: name, message: `the testkit has no minimal tree for <${tag}>: ${describeError(error)}` })
        continue
      }
      if (!rendered) continue
      const lowered = (parent: Tag) => rendered.report.degraded.filter(item => item.tag === parent)
      const blocked = parents.find(parent => lowered(parent).length > 0)
      if (blocked) {
        skipped.push({ case: name, reason: `cannot exercise <${tag}>: the container <${blocked}> degraded instead` })
        continue
      }
      const own = lowered(tag)[0]
      if (own) {
        problems.push({
          case: name,
          message: `<${tag}${variant ? `[${variant}]` : ''}> took the fallback (${own.via}) at ${own.path} `
            + `although the mode registers it`,
        })
      }
      problems.push(...textProblems(name, rendered.content, rendered.payloads))
    }
  }

  // 2 + 3. The shared corpus: text conservation and a complete report.
  const skip = new Set(options.skip ?? [])
  for (const item of [...corpusCases(), ...options.cases ?? []]) {
    const name = `corpus:${item.name}`
    if (skip.has(item.name) || skip.has(name)) {
      skipped.push({ case: name, reason: 'skipped by options.skip' })
      continue
    }
    const rendered = await run(name, item.content)
    if (!rendered) continue
    problems.push(...textProblems(name, rendered.content, rendered.payloads))
    problems.push(...reportProblems(name, rendered.content, rendered.report, selected))
  }

  return { mode, cases, problems, ok: problems.length === 0, skipped }
}

// ---------------------------------------------------------------------------------------------------------------
// Corpus rendering (goldens, e2e payload comparison)

export interface CorpusRendering {
  /** Corpus case name (`corpus:…` is conformance's label; this one is the bare name). */
  name: string
  title: string
  payloads: unknown[]
  report: RenderReport
}

export interface RenderCorpusOptions {
  target?: Target
  /** Extra cases rendered after the shared corpus. */
  cases?: { name: string; content: Fragment; title?: string }[]
  skip?: readonly string[]
  /** Cache shared by every case, so a repeated `src` uploads once (as in a real send). */
  cache?: import('../resource.ts').ResourceCache
}

/**
 * Render every corpus case through one mode (`normalize → transform → prepare → serialize`) and return the payloads:
 * the input of {@link expectGolden} for an adapter mode, and the same content the live e2e runner sends.
 */
export async function renderCorpus(
  adapter: Adapter<any, any>,
  mode: string,
  options: RenderCorpusOptions = {},
): Promise<CorpusRendering[]> {
  const selected = adapter.modes?.[mode] as Mode<any> | undefined
  if (!selected) {
    throw new Error(`renderCorpus: adapter "${adapter.id}" has no mode "${mode}" `
      + `(modes: ${Object.keys(adapter.modes ?? {}).join(', ') || 'none'})`)
  }
  const target = options.target ?? defaultTarget(adapter)
  const cache = options.cache ?? new MemoryResourceCache()
  const skip = new Set(options.skip ?? [])
  const out: CorpusRendering[] = []
  for (const item of [...corpusCases(), ...options.cases ?? []]) {
    if (skip.has(item.name)) continue
    const rendered = await renderContent(adapter, item.content, { target, mode: selected, cache })
    out.push({
      name: item.name, title: item.title ?? item.name, payloads: rendered.payloads, report: rendered.report,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Text of every `text` node of a normalized tree the render must show, in order (empty runs skipped).
 *
 * A `<fallback>` is left out: its candidates are alternatives the author ranked, so which one renders — and therefore
 * which of their texts appear — depends on the mode. The golden payload of the case still captures what a mode chose.
 *
 * @param root - normalized content tree.
 * @returns the text runs every mode has to keep.
 */
export function elementsText(root: Element): string[] {
  const out: string[] = []
  const walk = (el: Element) => {
    if (el.type === 'text') {
      if (el.attrs.content) out.push(el.attrs.content)
      return
    }
    if (el.type === 'fallback') return
    for (const child of el.children) walk(child)
  }
  walk(root)
  return out
}

/** Every string inside the payloads, de-escaped and joined: the haystack of the text-conservation check. */
export function payloadText(payloads: unknown): string {
  const strings: string[] = []
  const seen = new Set<object>()
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      strings.push(value)
      return
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    for (const item of Object.values(value as Record<string, unknown>)) walk(item)
  }
  walk(payloads)
  // Adapters escape markdown/HTML metacharacters with backslashes; dropping them compares the visible text.
  return strings.map(item => item.replace(/\\+/g, '')).join('\n')
}

/** Is `text` visible in the payload haystack, modulo escaping and whitespace? */
export function containsText(haystack: string, text: string): boolean {
  if (!text.trim()) return true
  if (haystack.includes(text) || haystack.includes(text.trim())) return true
  const squash = (value: string) => value.replace(/\s+/g, ' ').trim()
  return squash(haystack).includes(squash(text))
}

function textProblems(name: string, root: Element, payloads: unknown[]): ConformanceProblem[] {
  const haystack = payloadText(payloads)
  const problems: ConformanceProblem[] = []
  for (const text of elementsText(root)) {
    if (!containsText(haystack, text)) problems.push({ case: name, message: `text lost: ${JSON.stringify(text)}` })
  }
  return problems
}

/**
 * What the engine must report as degraded: the elements it cannot render (no handler) and the elements whose first
 * undeclared variant forces the fallback. The walk stops at a degraded element, because its children are replaced by
 * the fallback output and never reach the registry; a `<fallback>` contributes only its last candidate.
 */
export function expectedDegradations(root: Element, mode: Mode<any>): { tag: Tag; variant?: string }[] {
  const out: { tag: Tag; variant?: string }[] = []
  const visit = (el: Element, ancestors: Element[]) => {
    if (el.type === 'message') {
      for (const child of el.children) visit(child, [el])
      return
    }
    // `<quote>` and an envelope `<title>` are hoisted; `<markdown>` was expanded by its contribution.
    if (el.type === 'quote' || el.type === 'markdown' || el.type === 'case') return
    if (el.type === 'fallback') {
      // The same candidate the engine renders, so this checker and a render never disagree.
      const chosen = el.children[chosenCandidate(mode.elements, el.children, ancestors)]
      if (chosen) for (const child of chosen.children) visit(child, ancestors)
      return
    }
    // A root child the mode takes into its envelope never reaches the registry.
    if (ancestors.length === 1 && ancestors[0]!.type === 'message' && mode.elements.inEnvelope(el.type)) return
    const inner = [...ancestors, el]
    if (BASE_TAGS.has(el.type)) {
      for (const child of el.children) visit(child, inner)
      return
    }
    const entry = mode.elements.entry(el.type)
    if (!entry) {
      out.push({ tag: el.type })
      return
    }
    const declared = (entry.options.variants ?? []).map(String)
    const unsupported = variantsOf(el, ancestors).find(variant => !declared.includes(variant))
    if (unsupported) {
      out.push({ tag: el.type, variant: unsupported })
      return
    }
    for (const child of el.children) visit(child, inner)
  }
  visit(root, [])
  return out
}

function reportProblems(
  name: string,
  root: Element,
  report: RenderReport,
  mode: Mode<any>,
): ConformanceProblem[] {
  const problems: ConformanceProblem[] = []
  for (const expected of expectedDegradations(root, mode)) {
    const label = `<${expected.tag}${expected.variant ? `[${expected.variant}]` : ''}>`
    const found = report.degraded.some(item =>
      item.tag === expected.tag && (expected.variant === undefined || item.variant === expected.variant))
    if (!found) problems.push({ case: name, message: `report misses ${label}` })
  }
  return problems
}

/** Normalized tree of a corpus case (exported for tests that assert on the input, not the output). */
export function corpusInput(content: Fragment): Element {
  return normalize(content)
}
