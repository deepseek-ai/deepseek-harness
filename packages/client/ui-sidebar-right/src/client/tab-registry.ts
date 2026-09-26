/**
 * Stage one of tab-type registration: what a type IS.
 *
 * A registration is purely static — which addresses the type recognizes, how it
 * ranks against other types that recognize the same one, what the tab chip says,
 * and whether the type offers an entry box on the guide page. Nothing here is
 * per-tab, per-session, or a runtime hook: stage two is the keyed
 * `sidebar.right.pane.tab` registration that supplies the body under the same
 * `kind`, and everything a body needs at runtime arrives in its props.
 *
 * Address recognition follows VS Code's editor resolver: a glob declaration
 * narrows the candidates, an optional `canOpen` predicate vetoes, and the
 * survivors are ranked by priority band, then by matched-pattern length, then by
 * registration order. Addresses are `scheme://` URIs; the one local change to
 * VS Code's glob rule is that a pattern containing `:` matches the whole address
 * (`dsh-resource://file/**`, `sidebar://guide`) rather than the URI's path.
 *
 * A kind may carry one `builtin` and one `extension` registration at once: the
 * extension is the one in force — claims, `get`, the guide page, and the body
 * and title, which the seat finds under the definition's own `id` — and the
 * builtin resumes when the extension unregisters. Everything else colliding on
 * a kind throws, as does a second registration of an `id`.
 *
 * Thunked copy (`title`, `guide[].title`, `guide[].description`) is read again
 * on every use, so a language change needs no re-registration.
 */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
// The POSIX build: the browser bundle must not reach for node's `path`, and
// addresses are `/`-separated regardless of the host platform.
import picomatch from 'picomatch/posix'

/**
 * How strongly a type wants an address it recognizes, as one of three literal
 * bands (a string, not an imported constant, so a type shipped from another
 * package needs no runtime import from here).
 *
 * - `extension` — a type from outside the product, and the highest: a type that
 *   declares nothing outranks every viewer shipped here, exactly as in VS Code.
 *   It is also the band that may take over a `builtin` kind.
 * - `builtin` — the ordinary band for types shipped with the product.
 * - `fallback` — plain-content viewers that anything more specific should beat.
 *   VS Code's text editor holds this position implicitly; ours is a separate
 *   package, so it says so.
 */
export type SidebarRightTabPriority = 'extension' | 'builtin' | 'fallback'

/** Rank of each band, highest first. */
const RANKS: Readonly<Record<SidebarRightTabPriority, number>> = {
  extension: 3,
  builtin: 2,
  fallback: 1,
}

/** The band a definition that names none is in. */
const DEFAULT_BAND: SidebarRightTabPriority = 'extension'

/** One entry capsule the guide page offers, contributed by the type it opens (picking it opens that type as a page). */
export interface SidebarRightGuideEntry {
  /** Effective shortcut shown on this entry, when the provider registers one. */
  readonly commandId?: ShortcutCommandId
  /** Stable entry identity within its provider. */
  readonly id: string
  /** Ascending position among every registered type's entries. */
  readonly order: number
  /**
   * The capsule's title.
   * @returns the title in the current language.
   */
  readonly title: () => string
  /**
   * One line under the title on what picking the capsule opens. The guide shows
   * it only while it lists few enough entries to stay light; a crowded guide
   * falls back to titles alone, so a type must stand on its title.
   * @returns the description in the current language.
   */
  readonly description?: () => string
  /** Optional glyph, drawn before the title; without one the guide draws its cube placeholder. */
  readonly icon?: ComponentType<IconProps>
}

/** A guide entry as the registry lists it: with the kind of the type that contributed it, which is what picking it opens. */
export interface SidebarRightGuideBox extends SidebarRightGuideEntry {
  /** Active implementation identity used to dispatch the entry renderer. */
  readonly providerId: string
  readonly kind: string
}


/** One registered tab type: its static face, and nothing else. */
export interface SidebarRightTabDefinition {
  /**
   * This implementation's identity in the tab system, unique across every
   * registration (a package name is the natural value). A kind is not unique —
   * an extension may take a builtin's over — so the implementation carries its
   * own name, and it is the key its body and title register under in the
   * `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` seats.
   */
  readonly id: string
  /** Type discriminator: what the tabs of this type are, and what `openTab` names. */
  readonly kind: string
  /** Each open by kind creates independent content; omission keeps one page per kind in each pane. */
  readonly multiple?: boolean
  /** Lazily keep a visited body mounted through hiding, Session changes and docking; default false. */
  readonly keepMounted?: boolean
  /**
   * Resource-address globs this type recognizes; omit for a page type, which is
   * opened by kind and recognizes no address.
   *
   * A pattern containing `:` is matched against the whole address
   * (`dsh-resource://file/**`); one without is matched against the URI's path at
   * any depth (`*.md` matches `dsh-resource://file/session/s1/home/me/notes.md`),
   * and an address that is not a URI matches no such pattern. Matching ignores
   * case and does not hide dotfiles.
   */
  readonly patterns?: readonly string[]
  /** Defaults to `extension`: a type that says nothing is one from outside the product. */
  readonly priority?: SidebarRightTabPriority
  /**
   * Veto an address this type's globs matched.
   *
   * Synchronous and cheap: it runs on every routing decision. Omit it to accept
   * every match.
   * @param address - the matched address.
   * @returns whether this type will open it.
   */
  readonly canOpen?: (address: string) => boolean
  /**
   * The tab chip's initial text, captured into the layout record at open time.
   * @param address - the address being opened.
   * @returns the title in the current language.
   */
  readonly title: (address: string) => string
  /** Entry boxes for the guide page. Omit to stay off it. */
  readonly guide?: readonly SidebarRightGuideEntry[]
}

/** What a routing decision settles on: who draws the address, and as what. */
export interface SidebarRightTabClaim {
  /** The claiming type. */
  readonly kind: string
  /**
   * Stable identity of the content, which is the address itself.
   *
   * Two opens of the same address are the same tab, which is what makes opening
   * idempotent.
   */
  readonly contentId: string
  /** Title for the tab chip. */
  readonly title: string
}

/** A registered type with its patterns compiled. */
interface Registered {
  readonly definition: SidebarRightTabDefinition
  readonly band: SidebarRightTabPriority
  /** One matcher per declared pattern, in declaration order. */
  readonly matchers: readonly { readonly pattern: string; readonly test: (address: string) => boolean }[]
  /** Registration position across every kind, the last tiebreaker. */
  readonly order: number
}

/**
 * Everything registered under one kind: the registration in force and, while
 * an `extension` holds a kind a `builtin` also registered, the builtin it
 * shadows. A kind is in the registry's map exactly while something is in force
 * for it, so a held slot always answers.
 */
interface KindSlot {
  inForce: Registered
  shadowed: Registered | undefined
}

/**
 * Whether a band may join a held kind: an `extension` and a `builtin` pair up
 * once, and a `fallback` shares its kind with nothing.
 */
function coexists(slot: KindSlot, band: SidebarRightTabPriority): boolean {
  return band !== 'fallback' && slot.inForce.band !== 'fallback' && slot.inForce.band !== band && slot.shadowed === undefined
}

/** How a candidate ranked, kept only while `candidates` is sorting. */
interface Ranked {
  readonly definition: SidebarRightTabDefinition
  readonly rank: number
  /** Length of the longest pattern that matched, VS Code's specificity measure. */
  readonly length: number
  /** Registration position, the last tiebreaker. */
  readonly order: number
}

/**
 * The address's URI path: what a pattern with no scheme separator matches
 * against. `dsh-resource://file/session/s1/home/me/b.md` gives `/session/s1/home/me/b.md`;
 * `sidebar://guide` gives `''`; an address that is not a URI gives nothing.
 */
function pathOf(address: string): string | undefined {
  try {
    return new URL(address).pathname
  } catch {
    // The only thrower is the URL parser rejecting a non-URI address, which by
    // the rule above matches no path pattern.
    return undefined
  }
}

/** Compile one declared pattern into the test the router runs. */
function matcherFor(pattern: string): (address: string) => boolean {
  // `basename: true` is what makes `*.md` match at any depth; it applies only to
  // patterns without a separator, which is exactly the path case.
  const whole = pattern.includes(':')
  const match = picomatch(pattern, { nocase: true, dot: true, ...whole ? {} : { basename: true } })
  return (address) => {
    if (whole) return match(address)
    const path = pathOf(address)
    return path !== undefined && match(path)
  }
}

/**
 * The registered tab types.
 *
 * Registration order is part of the contract: it breaks ties between types that
 * recognize an address equally well.
 */
export class SidebarRightTabRegistry {
  private readonly kinds = new Map<string, KindSlot>()
  private readonly ids = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private registrations = 0
  private cached: readonly SidebarRightTabDefinition[] = []
  private guideEntries: readonly SidebarRightGuideBox[] = []

  /** @param ctx - Context whose effects own the contributed types. */
  constructor(private readonly ctx: Context) {}

  /**
   * Register one tab type for the caller's lifetime.
   *
   * The caller holds the returned disposer inside its own `ctx.effect`, so a
   * type's registration lives exactly as long as the plugin that contributed it.
   * An `extension` may register a kind a `builtin` already holds and takes it
   * over until it unregisters; a second registration in the same band, or any
   * registration meeting a `fallback` of the same kind, is a wiring mistake, and
   * so is an `id` already in use.
   * @param definition - the contributed type.
   * @returns idempotent disposer.
   * @throws when the id is taken, or the kind is already registered in a way this one cannot coexist with.
   */
  register(definition: SidebarRightTabDefinition): () => void {
    const { id, kind } = definition
    const entries = definition.guide ?? []
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error(`sidebarRight: duplicate guide entry id in "${id}"`)
    const band = definition.priority ?? DEFAULT_BAND
    if (this.ids.has(id)) throw new Error(`sidebarRight: tab type id "${id}" is already registered`)
    const held = this.kinds.get(kind)
    if (held !== undefined && !coexists(held, band)) {
      throw new Error(`sidebarRight: tab kind "${kind}" is already registered (${held.inForce.band})`)
    }
    this.registrations += 1
    const entry: Registered = {
      definition,
      band,
      matchers: (definition.patterns ?? []).map(pattern => ({ pattern, test: matcherFor(pattern) })),
      order: this.registrations,
    }
    const dispose = this.ctx.effect(() => {
      this.ids.add(id)
      const slot = this.enter(kind, entry)
      this.refresh()
      return () => {
        this.ids.delete(id)
        this.leave(kind, slot, entry)
        this.refresh()
      }
    }, `sidebarRight.tabs.register(${JSON.stringify(id)})`)
    return () => { void dispose() }
  }

  /** Add a registration to its kind's slot, the higher band in force; `coexists` has already admitted it. */
  private enter(kind: string, entry: Registered): KindSlot {
    const held = this.kinds.get(kind)
    if (held === undefined) {
      const slot: KindSlot = { inForce: entry, shadowed: undefined }
      this.kinds.set(kind, slot)
      return slot
    }
    if (RANKS[entry.band] > RANKS[held.inForce.band]) {
      held.shadowed = held.inForce
      held.inForce = entry
    } else {
      held.shadowed = entry
    }
    return held
  }

  /** Remove a registration from its kind's slot: a shadowed builtin resumes, and an emptied kind is freed. */
  private leave(kind: string, slot: KindSlot, entry: Registered): void {
    if (slot.inForce !== entry) {
      slot.shadowed = undefined
    } else if (slot.shadowed === undefined) {
      this.kinds.delete(kind)
    } else {
      slot.inForce = slot.shadowed
      slot.shadowed = undefined
    }
  }

  /** Every kind's registration in force, in registration order. */
  private active(): Registered[] {
    return [...this.kinds.values()].map(slot => slot.inForce).sort((left, right) => left.order - right.order)
  }

  /**
   * Registered types in registration order.
   * @returns reference-stable entries.
   */
  entries(): readonly SidebarRightTabDefinition[] {
    return this.cached
  }

  /**
   * Every type in force's guide entries, in `order`, each naming the kind it opens.
   * @returns reference-stable entries.
   */
  guide(): readonly SidebarRightGuideBox[] {
    return this.guideEntries
  }

  /**
   * The type in force for a kind.
   * @param kind - the type discriminator.
   * @returns the type, or `undefined` when nothing registered it.
   */
  get(kind: string): SidebarRightTabDefinition | undefined {
    return this.kinds.get(kind)?.inForce.definition
  }

  /**
   * Every type that would open an address, best first.
   *
   * Ranked by priority band, then by the length of the pattern that matched,
   * then by registration order. Types whose `canOpen` vetoes are absent.
   * @param address - the address a caller wants opened.
   * @returns the ranked types; empty when nothing recognizes the address.
   */
  candidates(address: string): readonly SidebarRightTabDefinition[] {
    const ranked: Ranked[] = []
    for (const { definition, band, matchers, order } of this.active()) {
      let length = -1
      for (const matcher of matchers) {
        if (matcher.test(address) && matcher.pattern.length > length) length = matcher.pattern.length
      }
      if (length < 0) continue
      if (definition.canOpen !== undefined && !definition.canOpen(address)) continue
      ranked.push({ definition, rank: RANKS[band], length, order })
    }
    ranked.sort((left, right) =>
      right.rank - left.rank || right.length - left.length || left.order - right.order)
    return ranked.map(entry => entry.definition)
  }

  /**
   * Decide which type opens an address, and as what.
   *
   * Without `kind`, the best candidate wins. With `kind`, that type opens the
   * address if its `canOpen` agrees — its globs are not consulted, because
   * naming the type IS the decision.
   *
   * An address no type will open is a wiring mistake, not a user error, so this
   * throws rather than reporting absence.
   * @param address - the address a caller wants opened.
   * @param kind - a type named by the caller, overriding the ranking.
   * @returns the claiming type and the record to open.
   */
  claim(address: string, kind?: string): SidebarRightTabClaim {
    if (kind !== undefined) {
      const definition = this.get(kind)
      if (definition === undefined) {
        throw new Error(`sidebarRight: no tab type is registered as "${kind}"`)
      }
      if (definition.canOpen !== undefined && !definition.canOpen(address)) {
        throw new Error(`sidebarRight: tab type "${kind}" refuses "${address}"`)
      }
      return { kind, contentId: address, title: definition.title(address) }
    }
    const [chosen] = this.candidates(address)
    if (chosen === undefined) {
      throw new Error(`sidebarRight: no registered tab type claims "${address}"`)
    }
    return { kind: chosen.kind, contentId: address, title: chosen.title(address) }
  }

  /**
   * Observe low-frequency registry changes.
   * @param listener - synchronous invalidation callback.
   * @returns unsubscribe callback.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private refresh(): void {
    this.cached = this.active().map(entry => entry.definition)
    this.guideEntries = this.cached
      .flatMap(definition => (definition.guide ?? []).map(entry => ({ ...entry, kind: definition.kind, providerId: definition.id })))
      .sort((left, right) => left.order - right.order)
    notifySubscribers(this.listeners, '[ui-sidebar-right] tab registry')
  }
}
