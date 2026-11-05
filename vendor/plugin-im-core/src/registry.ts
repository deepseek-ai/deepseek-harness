/**
 * Element registry, render context and the transform engine.
 *
 * Engine rules (`RenderEngine.render`):
 * 1. Base tags (`text`, `p`, `br`) always go to their handler (a mode without one is a programming error).
 * 2. Any other element is **native** when it has a handler, every variant of `variantsOf(el, ancestors)` is declared
 *    by the handler (`HandlerOptions.variants`), and — for structural containers — every structural child can stand
 *    as it is (see 4).
 * 3. Otherwise the element is lowered: the mode's override (`registry.fallback(tag, …)`) wins over the core table
 *    (`defaultFallback`). An unsupported variant passes `ctx.variant` (the first unsupported one, in
 *    `variantsOf` order); an unsupported tag passes none. The output is normalized against the element's parent
 *    (`normalizeChildren`), recorded as `RenderReport.degraded`, and rendered again. Each fallback application is
 *    one *step*; more than {@link MAX_FALLBACK_STEPS} nested steps throw (a fallback loop).
 * 4. Structural containers whose children are fixed by the content model (`ul`/`ol` → `li`, `table` → `tr` →
 *    `th`/`td`, `details` → `summary`, `button-group` → `button`, `select` → `option`) cannot host a lowered child (a
 *    `<p>` is not a valid child of `<ul>`), so when such a child is not native — and its missing variants are not
 *    tag-preserving (`preservingVariants`) — the container falls back as a whole.
 * 5. A `<fallback>` renders its first candidate whose every element, at any depth, is native (rule 2, with a nested
 *    `<fallback>` counting as native when one of its candidates is), else its last candidate with the usual lowering.
 *    A candidate other than the first is recorded in `RenderReport.fallbacks`. Candidates stand in the place of the
 *    `<fallback>`: their parent and ancestors are those of the `<fallback>`.
 * 6. Handlers and fallbacks are synchronous; returning a promise throws (`transform` is pure, I/O is `prepare`).
 * 7. Handlers come from the mode's registry first and from plugin contributions second (`contributions.ts`), so a tag
 *    no adapter names — a plugin's own element, contributed as a handler that calls `RenderContext.transform` — renders
 *    like any registered element and is otherwise lowered through the core fallback (rule 3). A mode that registers
 *    the tag itself keeps its own handler.
 *
 * Positions and ids: every element of the input (and of every fallback output) gets a *frame* with its parent, its
 * structural path (`message/ul[2]/li[0]`, the `normalize` error-path format) and its fallback depth. A keyed element
 * restarts the path at `#<key>`, so ids of keyed subtrees survive insertions above them. A fallback output that is
 * a single element of the same tag (variant strip) keeps the original path; other outputs get `<path>>/<tag>[i]`,
 * which is why `RenderReport.summary()` ignores entries with `>` (consequences, not user content). Candidates of a
 * `<fallback>` get `<path>/case[i]/…`.
 * `RenderContext.stableId(el)` returns that path; adapters hash/format it to platform rules.
 */

import {
  type ButtonCallback, type Element, type ElementKey, type Fragment, normalizeChildren, type SelectCallback, type Tag,
  toText, variantKey, variantsOf, type VariantOf,
} from '@deepseek-ai/satori-element'
import type { Bot } from './bot.ts'
import type { ElementContributions } from './contributions.ts'
import { defaultFallback, type Fallback, preservingVariants, type RenderReport } from './fallback.ts'
import type { ElementHandler, HandlerOptions, LimitKey, Mode, ModeTypes, InteractionAction } from './mode.ts'
import type { Target } from './protocol.ts'
import { type ResourceKind, type ResourceMeta, ResourceRef } from './resource.ts'
import type { StreamPhase } from './stream.ts'

export interface RenderContext<T extends ModeTypes> {
  readonly bot: Bot
  readonly target: Target
  readonly mode: string
  /** Whether the mode's registry renders `element.<tag>` (or `element.<tag>.<variant>`) natively. */
  renders(key: ElementKey): boolean
  /** A static bound the mode declares (`Mode.limits`). */
  limit(key: LimitKey): number | undefined
  /** Registry transform of children (recursion entry point). */
  render(children: readonly Element[]): T['node'][]
  /** Plain text of a subtree (escaping is the caller's job). */
  text(children: readonly Element[]): string
  /** Resource placeholder; resolved by prepare. Pure: no I/O happens here. */
  resource<K extends ResourceKind>(kind: K, src: string, meta?: ResourceMeta): ResourceRef<K>
  /** Stable id for diffing: from el.key, else structural path; adapter formats it to platform rules. */
  stableId(el: Element): string
  /** Outermost first, parent last (the `ancestors` argument of `variantsOf`). */
  readonly ancestors: readonly Element[]
  readonly report: RenderReport
  /**
   * The stream state this render publishes, `undefined` outside a stream. `final: false` is an intermediate state:
   * under the `append` strategy the platform keeps every character it was sent, so content that a later state would
   * render differently must stay back until it is final.
   */
  readonly stream: StreamPhase | undefined
  /**
   * Render `content` in place of the current element: normalized as content of the element's parent, rendered with
   * the parent's ancestors, and positioned under the element's path. Not a degradation — this is how an element that
   * expands into other elements (`<markdown>`) renders.
   */
  transform(content: Fragment): T['node'][]
}

/** A registered handler with its options (engine lookup). */
export interface RegistryEntry<T extends ModeTypes, K extends Tag = Tag> {
  tag: K
  handler: ElementHandler<T, K>
  options: HandlerOptions<K>
}

/** Tags a mode may take into its envelope instead of rendering them through a handler. */
export type EnvelopeTag = 'title'

/** Builder that tracks registered tags in its type (R), so element keys and mandatory tags are checked. */
export class ElementRegistry<T extends ModeTypes, R extends Tag = never> {
  private readonly entries = new Map<Tag, RegistryEntry<T, any>>()
  private readonly overrides = new Map<Tag, Fallback<any>>()
  private readonly envelopeTags = new Set<EnvelopeTag>()

  register<K extends Exclude<Tag, R>>(tag: K, handler: ElementHandler<T, K>, options: HandlerOptions<K> = {}): ElementRegistry<T, R | K> {
    if (this.entries.has(tag) || this.envelopeTags.has(tag as never)) throw new Error(`element <${tag}> is already registered`)
    this.entries.set(tag, { tag, handler, options })
    return this as unknown as ElementRegistry<T, R | K>
  }

  /**
   * Declare that the mode renders a root envelope tag itself: `transform` hands a root `<title>` to `assemble` as
   * `Envelope.title` instead of rendering it through the registry.
   */
  envelope<K extends Exclude<EnvelopeTag, R>>(tag: K): ElementRegistry<T, R | K> {
    if (this.entries.has(tag) || this.envelopeTags.has(tag)) throw new Error(`element <${tag}> is already registered`)
    this.envelopeTags.add(tag)
    return this as unknown as ElementRegistry<T, R | K>
  }

  /** Mode-specific fallback override (takes precedence over the core table). */
  fallback<K extends Tag>(tag: K, fallback: Fallback<K>): this {
    this.overrides.set(tag, fallback)
    return this
  }

  tags(): R[] {
    return [...this.entries.keys(), ...this.envelopeTags] as R[]
  }

  /** `element.<tag>` for every registered tag plus `element.<tag>.<variant>` for its declared variants. */
  keys(): ElementKey[] {
    const keys: ElementKey[] = []
    for (const { tag, options } of this.entries.values()) {
      keys.push(variantKey(tag))
      for (const variant of options.variants ?? []) keys.push(variantKey(tag, variant as VariantOf<typeof tag>))
    }
    for (const tag of this.envelopeTags) keys.push(variantKey(tag))
    return keys
  }

  /**
   * Whether the registry renders a key natively: `element.<tag>` when the tag is registered (as a handler or an
   * envelope tag), `element.<tag>.<variant>` when its handler also declares the variant.
   */
  has(key: ElementKey): boolean {
    const [, tag, variant] = key.split('.') as [string, Tag, string | undefined]
    if (variant === undefined && this.envelopeTags.has(tag as EnvelopeTag)) return true
    const entry = this.entries.get(tag)
    if (!entry) return false
    return variant === undefined || (entry.options.variants ?? []).includes(variant as never)
  }

  /** Whether the mode takes this root tag into its envelope. */
  inEnvelope(tag: Tag): boolean {
    return this.envelopeTags.has(tag as EnvelopeTag)
  }

  /** The registered handler of a tag, if any. */
  entry<K extends Tag>(tag: K): RegistryEntry<T, K> | undefined {
    return this.entries.get(tag)
  }

  /** The mode's fallback override of a tag, if any. */
  override<K extends Tag>(tag: K): Fallback<K> | undefined {
    return this.overrides.get(tag)
  }

  /**
   * Transform any (sub)tree into platform nodes, applying fallbacks; used by handlers through ctx.render.
   *
   * With a context created by this registry's engine this is `ctx.render(nodes)`. With any other context (tests,
   * a context of another registry) a fresh engine is created from its fields; the nodes are then taken as children
   * of `ctx.ancestors` (actions of `onClick` buttons are not collected in that case).
   */
  transform(nodes: readonly Element[], ctx: RenderContext<T>): T['node'][] {
    const engine = engineOf(ctx)
    if (engine && engine.registry === this) return ctx.render(nodes)
    const limits: Mode['limits'] = {}
    const fresh = new RenderEngine<T>(this, {
      bot: ctx.bot, target: ctx.target, mode: ctx.mode, limits: engine?.base.limits ?? limits, report: ctx.report,
      stream: ctx.stream, contributions: engine?.base.contributions,
    }, ctx.ancestors)
    return fresh.renderRoots(nodes)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Engine

/** Nested fallback applications allowed for one input element before the engine reports a loop. */
export const MAX_FALLBACK_STEPS = 8

const BASE_TAGS: ReadonlySet<Tag> = new Set<Tag>(['text', 'p', 'br'])

/** Children the content model fixes: a lowered child would be invalid there, so the container falls back. */
const STRUCTURAL: Partial<Record<Tag, readonly Tag[]>> = {
  'ul': ['li'],
  'ol': ['li'],
  'table': ['tr'],
  'tr': ['th', 'td'],
  'details': ['summary'],
  'button-group': ['button'],
  'select': ['option'],
}

const ENGINE = Symbol('plugin-im-core.render-engine')

function engineOf(ctx: RenderContext<any>): RenderEngine<any> | undefined {
  return (ctx as unknown as { [ENGINE]?: RenderEngine<any> })[ENGINE]
}

interface Frame {
  parent: Element | undefined
  path: string
  /** Fallback steps that produced this element (0 = input). */
  depth: number
}

/** Fields shared by every context of one render. */
export interface RenderBase {
  bot: Bot
  target: Target
  mode: string
  /** `Mode.limits` of the rendering mode. */
  limits: Mode['limits']
  report: RenderReport
  /** The stream state being rendered (`RenderContext.stream`). */
  stream?: StreamPhase | undefined
  /** Handlers plugins contribute for tags no mode registry declares. */
  contributions?: ElementContributions | undefined
}

/**
 * What one render treats as registered: the mode's registry first, contributed handlers second.
 *
 * @param registry - the mode's element registry.
 * @param contributions - handlers contributed by plugins, if any.
 * @returns the handler of a tag, or `undefined` when neither source has one.
 */
export function contributedEntry(
  registry: ElementRegistry<any, any>,
  contributions: ElementContributions | undefined,
  tag: Tag,
): RegistryEntry<any, any> | undefined {
  return registry.entry(tag) ?? contributions?.entry(tag)
}

/** A handler source: the mode registry and its contributions behind one lookup. */
export interface HandlerLookup {
  /** The handler of a tag, if anything renders it. */
  entry(tag: Tag): RegistryEntry<any, any> | undefined
  /** Whether the mode takes the tag into its envelope instead of rendering it through a handler. */
  inEnvelope(tag: Tag): boolean
}

function isThenable(value: unknown): boolean {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function'
}

function childPath(parentPath: string, el: Element, index: number) {
  return el.key !== undefined ? `#${el.key}` : `${parentPath}/${el.type}[${index}]`
}

class Context<T extends ModeTypes> implements RenderContext<T> {
  declare readonly [ENGINE]: RenderEngine<T>

  constructor(engine: RenderEngine<T>, private readonly current: Element | undefined, readonly ancestors: readonly Element[]) {
    Object.defineProperty(this, ENGINE, { value: engine })
  }

  get bot() { return this[ENGINE].base.bot }
  get target() { return this[ENGINE].base.target }
  get mode() { return this[ENGINE].base.mode }
  get report() { return this[ENGINE].base.report }
  get stream() { return this[ENGINE].base.stream }

  transform(content: Fragment): T['node'][] {
    if (!this.current) throw new Error('RenderContext.transform() renders in place of an element; this context has none')
    return this[ENGINE].renderInPlace(this.current, content)
  }

  renders(key: ElementKey): boolean {
    return this[ENGINE].renders(key)
  }

  limit(key: LimitKey): number | undefined {
    return this[ENGINE].base.limits[key]
  }

  render(children: readonly Element[]): T['node'][] {
    return this[ENGINE].renderChildren(children, this.current)
  }

  text(children: readonly Element[]): string {
    return toText(children)
  }

  resource<K extends ResourceKind>(kind: K, src: string, meta?: ResourceMeta): ResourceRef<K> {
    return new ResourceRef(kind, src, meta)
  }

  stableId(el: Element): string {
    return this[ENGINE].stableId(el, this.current)
  }
}

/**
 * One render of a registry: frames (positions, paths, fallback depth), the report and the collected `onClick`
 * actions. Created by `transform()`; exported for testkits that render subtrees directly.
 */
export class RenderEngine<T extends ModeTypes> {
  private readonly frames = new WeakMap<Element, Frame>()
  private readonly collected = new Map<string, InteractionAction>()

  constructor(
    readonly registry: ElementRegistry<T, any>,
    readonly base: RenderBase,
    /** Ancestors of parentless frames (outermost first); `[]` for a `<message>` root. */
    private readonly outer: readonly Element[] = [],
  ) {}

  /** The handler of a tag: the mode's own registration, else what a plugin contributes. */
  entry(tag: Tag): RegistryEntry<any, any> | undefined {
    return contributedEntry(this.registry, this.base.contributions, tag)
  }

  /** Whether the mode takes the tag into its envelope (a contributed handler never does). */
  inEnvelope(tag: Tag): boolean {
    return this.registry.inEnvelope(tag)
  }

  /** Whether `element.<tag>` / `element.<tag>.<variant>` renders natively, contributions included. */
  renders(key: ElementKey): boolean {
    if (this.registry.has(key)) return true
    const [, tag, variant] = key.split('.') as [string, Tag, string | undefined]
    return variant === undefined && this.entry(tag) !== undefined
  }

  /** Interaction callbacks of natively rendered controls, first registration per id wins. */
  actions(): InteractionAction[] {
    return [...this.collected.values()]
  }

  /**
   * Register a tree (or subtree) so every element has a parent, a path and a depth. The candidates of a `<fallback>`
   * take the `<fallback>`'s parent, because the chosen one stands in its place.
   */
  register(el: Element, parent: Element | undefined, path: string, depth: number): void {
    this.frames.set(el, { parent, path, depth })
    if (el.type === 'fallback') {
      el.children.forEach((candidate, index) => {
        const casePath = `${path}/case[${index}]`
        this.frames.set(candidate, { parent, path: casePath, depth })
        candidate.children.forEach((child, at) => this.register(child, parent, childPath(casePath, child, at), depth))
      })
      return
    }
    el.children.forEach((child, index) => this.register(child, el, childPath(path, child, index), depth))
  }

  /** Context whose `render()` renders children of `el` (`ancestors` are those of `el`). */
  context(el: Element | undefined): RenderContext<T> {
    return new Context(this, el, el ? this.ancestorsOf(el) : this.outer)
  }

  /** Render top-level nodes (no registered parent): the children of `outer`. */
  renderRoots(nodes: readonly Element[]): T['node'][] {
    nodes.forEach((node, index) => {
      if (!this.frames.has(node)) this.register(node, undefined, childPath('~', node, index), 0)
    })
    return nodes.flatMap(node => this.render(node))
  }

  /** Render elements as children of `parent` (elements unknown to the engine are registered under it). */
  renderChildren(children: readonly Element[], parent: Element | undefined): T['node'][] {
    if (!parent) return this.renderRoots(children)
    const frame = this.frames.get(parent)
    const parentPath = frame?.path ?? '~'
    children.forEach((child, index) => {
      if (this.frames.has(child)) return
      const at = parent.children.indexOf(child)
      const path = at >= 0 ? childPath(parentPath, child, at) : childPath(`${parentPath}/~`, child, index)
      this.register(child, parent, path, frame?.depth ?? 0)
    })
    return children.flatMap(child => this.render(child))
  }

  stableId(el: Element, current: Element | undefined): string {
    const frame = this.frames.get(el)
    if (frame) return frame.path
    if (el.key !== undefined) return `#${el.key}`
    const base = current ? this.frames.get(current)?.path ?? '~' : '~'
    return `${base}/~${el.type}`
  }

  ancestorsOf(el: Element): Element[] {
    const out: Element[] = []
    let parent = this.frames.get(el)?.parent
    while (parent) {
      out.push(parent)
      parent = this.frames.get(parent)?.parent
    }
    out.reverse()
    return [...this.outer, ...out]
  }

  /**
   * The candidate of a `<fallback>` a render uses (rule 5), recorded in the report when it is not the first.
   *
   * @param el - the `<fallback>`, registered with this engine.
   * @returns the chosen `<case>`, or `undefined` for a `<fallback>` without candidates.
   */
  choose(el: Element): Element | undefined {
    const candidates = el.children
    if (!candidates.length) return undefined
    const ancestors = this.ancestorsOf(el)
    const index = chosenCandidate(this, candidates, ancestors)
    if (index > 0) this.base.report.fallbacks.push({ path: this.frameOf(el).path, candidate: index })
    return candidates[index]
  }

  private frameOf(el: Element): Frame {
    let frame = this.frames.get(el)
    if (!frame) {
      this.register(el, undefined, `~/${el.type}`, 0)
      frame = this.frames.get(el)!
    }
    return frame
  }

  /** Render one element: its handler when native, else its fallback output (rules 1–5). */
  render(el: Element): T['node'][] {
    const frame = this.frameOf(el)
    if (el.type === 'fallback') {
      const chosen = this.choose(el)
      return chosen ? chosen.children.flatMap(child => this.render(child)) : []
    }
    const ancestors = this.ancestorsOf(el)
    const entry = this.entry(el.type)
    if (BASE_TAGS.has(el.type)) {
      if (!entry) throw new Error(`mode "${this.base.mode}" has no handler for the base tag <${el.type}>`)
      return this.call(entry, el, ancestors)
    }
    if (entry) {
      const variant = variantsOf(el, ancestors).find(v => !this.declares(entry, v))
      if (variant !== undefined) return this.lower(el, frame, ancestors, variant)
      if (!this.structuralOk(el, ancestors)) return this.lower(el, frame, ancestors, undefined)
      return this.call(entry, el, ancestors)
    }
    return this.lower(el, frame, ancestors, undefined)
  }

  private declares(entry: RegistryEntry<T, any>, variant: string): boolean {
    return declares(entry, variant)
  }

  private structuralOk(el: Element, ancestors: readonly Element[]): boolean {
    return structuralOk(this, el, ancestors)
  }

  private call(entry: RegistryEntry<T, any>, el: Element, ancestors: readonly Element[]): T['node'][] {
    const ctx = new Context(this, el, ancestors)
    const out = entry.handler(el, ctx)
    if (isThenable(out)) {
      throw new TypeError(`handler of <${el.type}> in mode "${this.base.mode}" returned a promise; transform is synchronous (do I/O in prepare)`)
    }
    if (el.type === 'button' && (el.attrs.type === 'action' || el.attrs.type === 'submit')) {
      const { id, onClick } = el.attrs
      if (onClick && !this.collected.has(id)) this.collected.set(id, { kind: 'button', id, callback: onClick })
    } else if (el.type === 'select' && el.attrs.onSelect) {
      // A select without an id is a form field only: it names no callback, so there is nothing to collect.
      const { id, onSelect } = el.attrs
      if (id !== undefined && !this.collected.has(id)) this.collected.set(id, { kind: 'select', id, callback: onSelect })
    } else if (el.type === 'input' && el.attrs.onChange) {
      const { id, onChange } = el.attrs
      if (id !== undefined && !this.collected.has(id)) this.collected.set(id, { kind: 'check', id, callback: onChange })
    }
    if (out === undefined) return []
    return Array.isArray(out) ? [...out] : [out as T['node']]
  }

  /**
   * Render `content` standing in the place of `el` ({@link RenderContext.transform}): normalized against `el`'s
   * parent, registered under that parent with paths below `el`'s own, at `el`'s fallback depth.
   *
   * @param el - the element being replaced, registered with this engine.
   * @param content - what renders in its place.
   * @returns the platform nodes of `content`.
   * @throws Error when `content` is not allowed where `el` stands.
   */
  renderInPlace(el: Element, content: Fragment): T['node'][] {
    const frame = this.frameOf(el)
    const parent = frame.parent
    const parentTag: Tag = parent?.type ?? this.outer[this.outer.length - 1]?.type ?? 'message'
    let nodes: Element[]
    try {
      nodes = normalizeChildren(content, parentTag, frame.path)
    } catch (error) {
      throw new Error(`<${el.type}> at ${frame.path} rendered content not allowed in <${parentTag}>: ${(error as Error).message}`, { cause: error })
    }
    nodes.forEach((node, index) => this.register(node, parent, childPath(`${frame.path}>`, node, index), frame.depth))
    return nodes.flatMap(node => this.render(node))
  }

  /** Rule 3: apply the override or core fallback and render its output. */
  private lower(el: Element, frame: Frame, ancestors: readonly Element[], variant: string | undefined): T['node'][] {
    const label = `<${el.type}${variant ? `[${variant}]` : ''}> at ${frame.path}`
    const override = this.registry.override(el.type)
    const fallback = override ?? defaultFallback(el.type)
    if (!fallback) throw new Error(`mode "${this.base.mode}" cannot render ${label} and the tag has no fallback`)
    if (frame.depth >= MAX_FALLBACK_STEPS) {
      throw new Error(`fallback chain of ${label} exceeds ${MAX_FALLBACK_STEPS} steps (a fallback loop?)`)
    }
    const output = (fallback as Fallback<Tag>)(el as never, {
      renders: key => this.renders(key),
      ...variant !== undefined && { variant },
      ancestors,
      report: this.base.report,
    })
    if (isThenable(output)) throw new TypeError(`fallback of ${label} returned a promise; transform is synchronous`)
    const parent = frame.parent
    const parentTag: Tag = parent?.type ?? this.outer[this.outer.length - 1]?.type ?? 'message'
    let nodes: Element[]
    try {
      nodes = normalizeChildren(output as never, parentTag, frame.path)
    } catch (error) {
      throw new Error(`fallback of ${label} produced content not allowed in <${parentTag}>: ${(error as Error).message}`, { cause: error })
    }
    const same = nodes.length === 1 && nodes[0]!.type === el.type
    this.base.report.degraded.push({
      tag: el.type,
      ...variant !== undefined && { variant },
      via: `${override ? 'mode:' : ''}${describe(nodes, same)}`,
      path: frame.path,
    })
    nodes.forEach((node, index) => {
      const path = same ? frame.path : childPath(`${frame.path}>`, node, index)
      this.register(node, parent, path, frame.depth + 1)
    })
    return nodes.flatMap(node => this.render(node))
  }
}

/** Whether a handler declares `variant` (a declared variant renders with the tag). */
function declares(entry: RegistryEntry<any, any>, variant: string): boolean {
  return (entry.options.variants ?? []).includes(variant as never)
}

/** Rule 4: can every structural child of `el` stand as it is? */
function structuralOk(lookup: HandlerLookup, el: Element, ancestors: readonly Element[]): boolean {
  const fixed = STRUCTURAL[el.type]
  if (!fixed) return true
  const inner = [...ancestors, el]
  return el.children.every(child => stands(lookup, child, fixed, inner))
}

function stands(lookup: HandlerLookup, child: Element, fixed: readonly Tag[], inner: readonly Element[]): boolean {
  if (child.type === 'fallback') {
    return child.children.some(candidate => candidate.children.every(node => stands(lookup, node, fixed, inner)))
  }
  if (!fixed.includes(child.type)) return true
  const entry = lookup.entry(child.type)
  if (!entry) return false
  const ok = variantsOf(child, inner).every(v => declares(entry, v) || preservingVariants.has(`${child.type}.${v}`))
  return ok && structuralOk(lookup, child, inner)
}

function nativeTree(lookup: HandlerLookup, el: Element, ancestors: readonly Element[]): boolean {
  if (el.type === 'fallback') return el.children.some(candidate => nativeAll(lookup, candidate.children, ancestors))
  // A root child the mode takes into its envelope is rendered by `assemble`, not lowered.
  if (ancestors.length === 1 && ancestors[0]!.type === 'message' && lookup.inEnvelope(el.type)) return true
  const inner = [...ancestors, el]
  if (BASE_TAGS.has(el.type)) return nativeAll(lookup, el.children, inner)
  const entry = lookup.entry(el.type)
  if (!entry) return false
  if (!variantsOf(el, ancestors).every(v => declares(entry, v))) return false
  if (!structuralOk(lookup, el, ancestors)) return false
  return nativeAll(lookup, el.children, inner)
}

/**
 * Index of the candidate a render of `<fallback>` chooses: the first one whose whole subtree is native, else the last.
 *
 * @param lookup - the handlers a candidate counts as native against (a mode registry, or an engine with its
 * contributions).
 * @param candidates - the `<fallback>`'s candidate cases, in author order.
 * @param ancestors - ancestors of the `<fallback>`, outermost first, parent last.
 * @returns the chosen index; `0` for an empty candidate list.
 */
export function chosenCandidate(lookup: HandlerLookup, candidates: readonly Element[], ancestors: readonly Element[]): number {
  const index = candidates.findIndex(candidate => nativeAll(lookup, candidate.children, ancestors))
  return index < 0 ? Math.max(0, candidates.length - 1) : index
}

function nativeAll(lookup: HandlerLookup, nodes: readonly Element[], ancestors: readonly Element[]): boolean {
  return nodes.every(node => nativeTree(lookup, node, ancestors))
}
/** `via` of a degraded entry: `strip` (same tag, variant dropped), `empty`, or the output's top-level tags. */
function describe(nodes: readonly Element[], same: boolean): string {
  if (same) return 'strip'
  if (!nodes.length) return 'empty'
  return [...new Set(nodes.map(node => node.type))].join('+')
}
