/**
 * InputTriggerController: the per-session half of the trigger pipeline. Owns every
 * piece of mutable interaction state — the authoritative trigger hit (span
 * included; it outlives menu close for space adjudication), the menu store,
 * and the candidate-fetch lifecycle — and executes pick outcomes by
 * dispatching the scoped input-mutation events. The root InputTriggerService keeps
 * only the source roster. One controller per session scope; the service
 * disposes it with the scope fiber.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ArbitrateKey, ArbitrateOutcome, PickOutcome,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { detectTrigger } from '../core/detect.ts'
import { MENU_CLOSED, menuReduce, seedGroups } from '../core/menu.ts'
import type { MenuEvent, MenuState, TriggerHit } from '../core/contract.ts'
import type {
  ClientSessionContext, InputTriggerCandidate, InputTriggerCrumb, InputTriggerSource, PickAction,
  SubmitEnvelope, TriggerChar, TriggerGuard,
} from '../types.ts'

/** Roster access the controller borrows from the root service (registration order preserved). */
export interface SourceRoster {
  sources(trigger: string): readonly InputTriggerSource[]
  all(): readonly InputTriggerSource[]
}

/** Construction hooks for one controller. */
export interface InputTriggerControllerDeps {
  /** The owning session scope (event dispatch + teardown registration site). */
  actx: ClientContext
  /** The session's stable host identity (the projection handed to sources). */
  sessionId: SessionId
  /** Root-service roster view. */
  roster: SourceRoster
}

/**
 * Per-session trigger pipeline state and orchestration. All mutation stays
 * inside; MenuView renders from {@link InputTriggerController.menu} and routes
 * pointer picks back through {@link InputTriggerController.pick}.
 */
export class InputTriggerController {
  /** Menu state store (per-session; survives session switches, dies with the scope). */
  readonly menu: SnapshotStore<MenuState> = createSnapshotStore<MenuState>(MENU_CLOSED)
  /**
   * Name of the source opened through the programmatic launcher, or null for
   * trigger-detected/closed menus. Composer chrome subscribes to this store
   * for the launcher's expanded state without owning a second menu model.
   */
  readonly launcher: SnapshotStore<string | null> = createSnapshotStore<string | null>(null)
  /**
   * Crumbs published by each header-bearing source for the open menu, keyed
   * by source name. A snapshot store like {@link InputTriggerController.launcher}:
   * the answer changes with every hit, and render-side consumers subscribe
   * instead of re-polling sources during a render.
   */
  readonly headers: SnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>> =
    createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(new Map())
  /**
   * Aggregated hot reference lexicon, grouped by trigger (plain-text-reference decision;
   * see .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
   * sources implementing the lexicon hook are polled with the session
   * projection; undefined answers (roll not hot yet) are skipped; multiple
   * sources on one trigger concatenate in registration order. A snapshot
   * store because rolls change asynchronously (catalog settles, children
   * spawn/exit) — render-side consumers subscribe instead of re-reading a
   * mutable answer.
   */
  readonly lexicon: SnapshotStore<ReadonlyMap<TriggerChar, readonly string[]>> =
    createSnapshotStore<ReadonlyMap<TriggerChar, readonly string[]>>(new Map())

  /** The authoritative hit: single truth for span CAS material (menu snapshot never carries it alone). */
  private hit: TriggerHit | null = null
  /** Whether the open menu was reached by a drill pick; cleared with the menu. */
  private drilled = false
  private fetch: AbortController | null = null
  private disposed = false
  /** Per-source lexicon unsubscribers (sources without the hook never enter). */
  private readonly lexiconOffs = new Map<InputTriggerSource, () => void>()

  constructor(private readonly deps: InputTriggerControllerDeps) {
    // Scope-birth prewarm: sessions are always agent-backed, so the one-time
    // roster warm here replaces the projection-transition watch — there are
    // no capability steps to react to.
    const projection = this.project()
    for (const src of deps.roster.all()) {
      src.warm?.(projection)
      this.watchLexicon(src, projection)
    }
    this.refreshLexicon()
  }

  /**
   * Feed a draft/caret change through trigger detection and drive the menu.
   * @param draft - full draft text.
   * @param caret - caret offset into `draft`.
   * @param guard - availability tier derived from the input phase.
   * @param draftRev - the input machine's current draft revision, stamped
   * into the hit span for pick-time CAS.
   */
  track(draft: string, caret: number, guard: TriggerGuard, draftRev: number): void {
    if (this.disposed) return
    const launched = this.launcher.getSnapshot() !== null
    this.clearLauncher()
    const raw = detectTrigger(draft, caret, guard)
    if (raw === null) {
      this.hit = null
      this.stopFetch()
      this.reduce({ type: 'close' })
      return
    }
    const hit: TriggerHit = { ...raw, span: { ...raw.span, draftRev } }
    const prev = this.menu.getSnapshot()
    const same = !launched && prev.open && prev.hit !== null
      && prev.hit.trigger === hit.trigger && prev.hit.query === hit.query
      && prev.hit.quoted === hit.quoted
      && prev.hit.span.start === hit.span.start && prev.hit.span.end === hit.span.end
    this.hit = hit
    if (same) return
    const roster = this.deps.roster.sources(hit.trigger)
    if (roster.length === 0) {
      this.stopFetch()
      this.reduce({ type: 'close' })
      return
    }
    if (launched || !prev.open || prev.hit === null || prev.hit.trigger !== hit.trigger) {
      this.menu.set(seedGroups(this.menu.getSnapshot(), roster))
    }
    this.reduce({ type: 'hit', hit })
    this.refreshHeaders(hit, roster)
    this.fetchCandidates(hit, roster)
  }

  /**
   * Toggle a menu containing exactly one registered source. The supplied hit
   * is a synthetic selection span rather than a typed trigger token, but
   * picks deliberately reuse the ordinary source callback and scoped input
   * mutation pipeline.
   * @param source - registered source name under `hit.trigger`.
   * @param hit - synthetic hit carrying position and pick-time draft CAS.
   */
  toggleSource(source: string, hit: TriggerHit): void {
    if (this.disposed) return
    if (this.launcher.getSnapshot() === source && this.menu.getSnapshot().open) {
      this.dismiss()
      return
    }
    const match = this.deps.roster.sources(hit.trigger).find(item => item.name === source)
    if (match === undefined) {
      this.dismiss()
      return
    }
    this.stopFetch()
    this.hit = hit
    this.launcher.set(source)
    this.menu.set(seedGroups(this.menu.getSnapshot(), [match]))
    this.reduce({ type: 'hit', hit })
    this.refreshHeaders(hit, [match])
    this.fetchCandidates(hit, [match])
  }

  /**
   * Pointer pick from MenuView: route the clicked candidate through onPick
   * and execute claim/insert outcomes via the scoped input events.
   * @param source - source (group) name.
   * @param index - candidate index within the group.
   * @param action - settling pick (default) or the candidate's drill action.
   */
  pick(source: string, index: number, action: PickAction = 'pick'): void {
    const state = this.menu.getSnapshot()
    const hit = this.hit
    if (this.disposed || !state.open || hit === null) return
    const group = state.groups.find(g => g.source === source)
    const candidate = group !== undefined && group.status === 'ready' ? group.items[index] : undefined
    if (candidate === undefined) return
    const src = this.deps.roster.sources(hit.trigger).find(s => s.name === source)
    if (src === undefined) return
    this.settle(src, candidate, hit, action)
  }

  /**
   * Pointer pick on one crumb of a source's menu header: route it through the
   * same drill path a folder row takes, so returning to a step and descending
   * into one share one outcome.
   * @param source - source (group) name.
   * @param index - crumb index within that source's published header.
   */
  pickCrumb(source: string, index: number): void {
    const hit = this.hit
    if (this.disposed || !this.menu.getSnapshot().open || hit === null) return
    const crumb = this.headers.getSnapshot().get(source)?.[index]
    if (crumb === undefined || crumb.current === true) return
    const src = this.deps.roster.sources(hit.trigger).find(s => s.name === source)
    if (src === undefined) return
    this.settle(src, { name: crumb.label, value: crumb.value }, hit, 'drill')
  }

  /**
   * Pointer hover from MenuView: park the shared highlight on the hovered
   * candidate (keyboard `move` and pointer hover drive one highlight —
   * last input wins).
   * @param source - source (group) name.
   * @param index - candidate index within the group.
   */
  hover(source: string, index: number): void {
    if (this.disposed) return
    this.reduce({ type: 'hover', source, index })
  }

  /**
   * Keyboard arbitration while the menu is open.
   * @param key - intercepted key.
   * @param composing - inside IME composition: everything passes.
   * @returns `pass` when the browser keeps the key (closed menu, no
   * highlight, or a vanished candidate), `consumed` when the menu handled
   * the key without a settling pick (move, close, drill descent, or a
   * pending-refinement no-op), or `pick-highlighted` when the highlighted
   * candidate settled and the menu closed.
   */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome {
    if (composing || this.disposed) return 'pass'
    const state = this.menu.getSnapshot()
    if (!state.open) return 'pass'
    switch (key) {
      case 'up': {
        this.reduce({ type: 'move', dir: -1 })
        return 'consumed'
      }
      case 'down': {
        this.reduce({ type: 'move', dir: 1 })
        return 'consumed'
      }
      case 'escape': {
        this.stopFetch()
        this.reduce({ type: 'close' })
        return 'consumed'
      }
      case 'enter': {
        if (state.highlight === null) return 'pass'
        // Refinement keeps the previous rows and highlight visible while the
        // next fetch is pending; Enter then neither picks the stale row nor
        // falls through to submit — an explicit no-op until the group is ready.
        const group = state.groups.find(g => g.source === state.highlight?.source)
        if (group === undefined || group.status !== 'ready') return 'consumed'
        this.pick(state.highlight.source, state.highlight.index)
        return 'pick-highlighted'
      }
      case 'tab': {
        if (state.highlight === null) return 'pass'
        const group = state.groups.find(g => g.source === state.highlight?.source)
        // Pending refinement keeps the stale highlight visible: consume the
        // gesture rather than pick a stale row or let Tab move focus away.
        if (group === undefined || group.status !== 'ready') return 'consumed'
        const item = group.items[state.highlight.index]
        if (item === undefined) return 'pass'
        if (item.drill === true) {
          this.pick(state.highlight.source, state.highlight.index, 'drill')
          return 'consumed'
        }
        this.pick(state.highlight.source, state.highlight.index)
        return 'pick-highlighted'
      }
    }
  }

  /**
   * Space adjudication over the just-completed leading token: polls sources'
   * matchSpace (hot state, synchronous) and dispatches the outcome itself.
   * @returns true when a claim/insert was actually applied by the input —
   * the caller preventDefaults exactly then.
   */
  onSpace(): boolean {
    const hit = this.hit
    if (this.disposed || hit === null || hit.position !== 'leading') return false
    const token = hit.trigger + hit.query
    const projection = this.project()
    for (const src of this.deps.roster.sources(hit.trigger)) {
      if (src.matchSpace === undefined) continue
      const outcome = src.matchSpace(projection, token)
      if (outcome === undefined) continue
      if (outcome === 'handled') return true
      return this.execute(outcome, hit.span)
    }
    return false
  }

  /**
   * Serialize one reference occurrence to its model form via the owning
   * source's codec (prompt serialization: registry → explicit
   * call → await). Owner missing or codec-less rejects — the submit attempt
   * blocks instead of silently downgrading to the clipboard text.
   * @param source - owning source name.
   * @param ref - owner-scoped reference id.
   * @param signal - the submit attempt's abort signal.
   * @returns the model representation (e.g. `<skill>name</skill>`).
   */
  serializeReference(source: string, ref: string, signal: AbortSignal): Promise<string> {
    const owner = this.deps.roster.all().find(s => s.name === source)
    if (owner?.codec === undefined) {
      return Promise.reject(new Error(`slash: no serializer for reference source "${source}"`))
    }
    return owner.codec.serialize(ref, signal)
  }

  /**
   * Enter last adjudication: polls sources' matchEnter in registration
   * order, first non-undefined wins. The outcome returns to the caller (the
   * input machine applies it inside the same submit attempt — no event).
   * @param line - trimmed draft; the leading char selects the trigger roster.
   * @param signal - attempt-scoped abort from the input machine.
   * @param envelope - non-text submission state accompanying the draft.
   * @returns the winning outcome or undefined (default sink). Rejects when a
   * polled source's warmup fails or the winning source refuses the envelope —
   * the caller must not silently downgrade.
   */
  async adjudicate(line: string, signal: AbortSignal, envelope: SubmitEnvelope): Promise<PickOutcome> {
    const projection = this.project()
    for (const src of this.deps.roster.all()) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('slash adjudication aborted')
      }
      if (src.matchEnter === undefined || !line.startsWith(src.trigger)) continue
      const outcome = await src.matchEnter(projection, line, signal, envelope)
      if (outcome !== undefined) return outcome
    }
    return undefined
  }

  /**
   * Drop the menu group of a disposed source (root registry change notification).
   * @param source - the source whose registration was disposed.
   */
  sourceRemoved(source: InputTriggerSource): void {
    const state = this.menu.getSnapshot()
    if (state.open && state.hit !== null && state.hit.trigger === source.trigger) {
      this.reduce({ type: 'source-failed', generation: state.generation, source: source.name })
    }
    this.lexiconOffs.get(source)?.()
    this.lexiconOffs.delete(source)
    this.refreshLexicon()
  }

  /**
   * Admit a source registered after this controller's birth (root registry
   * change notification): warm it and fold its roll into the live lexicon —
   * the constructor-time prewarm covers only the roster present at scope
   * birth.
   * @param source - the newly registered source.
   */
  sourceAdded(source: InputTriggerSource): void {
    const projection = this.project()
    source.warm?.(projection)
    this.watchLexicon(source, projection)
    this.refreshLexicon()
  }

  /** External dismiss (e.g. pointer outside the composer area). */
  dismiss(): void {
    if (this.disposed) return
    this.stopFetch()
    this.reduce({ type: 'close' })
  }

  /** Scope teardown: close and abort (the service deletes the map entry). */
  dispose(): void {
    this.disposed = true
    this.stopFetch()
    this.reduce({ type: 'close' })
    this.hit = null
    for (const off of this.lexiconOffs.values()) off()
    this.lexiconOffs.clear()
  }

  /** The session projection handed to sources (agent-backed identity; constant per scope). */
  private project(): ClientSessionContext {
    return { sessionId: this.deps.sessionId }
  }

  /** Execute a claim/insert/text outcome via the scoped input events (actx as dispatch subject); true = the input applied it. */
  private execute(outcome: PickOutcome, span: import('../types.ts').TokenSpan): boolean {
    const { actx } = this.deps
    if (outcome === undefined || outcome === 'handled') return false
    if ('claim' in outcome) {
      return actx.bail(actx, 'slash/input-begin-command', { claim: outcome.claim, span }) === true
    }
    if ('text' in outcome) {
      return actx.bail(actx, 'slash/input-insert-text', {
        text: outcome.text,
        span,
        ...outcome.continue === true ? { continue: true } : {},
      }) === true
    }
    return actx.bail(actx, 'slash/input-insert-reference', { reference: outcome.insert, span }) === true
  }

  /** Re-poll every lexicon-bearing source and publish the aggregated rolls (see the store doc). */
  private refreshLexicon(): void {
    const projection = this.project()
    const rolls = new Map<TriggerChar, readonly string[]>()
    for (const src of this.deps.roster.all()) {
      if (src.lexicon === undefined) continue
      let names: readonly string[] | undefined
      try {
        names = src.lexicon(projection)
      } catch (error) {
        // A faulty source drops silently with a console record (the
        // candidate-fetch failure policy); the refresh runs inside
        // notification callbacks, where a throw would starve other consumers.
        console.error(`[ui-input-trigger] source "${src.name}" lexicon failed:`, error)
        continue
      }
      if (names === undefined) continue
      const prev = rolls.get(src.trigger)
      rolls.set(src.trigger, prev === undefined ? names : [...prev, ...names])
    }
    this.lexicon.set(rolls)
  }

  /** Wire one source's lexicon invalidation channel into refresh (hookless or roll-less sources never notify). */
  private watchLexicon(source: InputTriggerSource, projection: ClientSessionContext): void {
    if (source.lexicon === undefined || source.subscribeLexicon === undefined) return
    this.lexiconOffs.set(source, source.subscribeLexicon(projection, () => {
      this.refreshLexicon()
      const hit = this.hit
      if (hit === null || !this.menu.getSnapshot().open || hit.trigger !== source.trigger) return
      // Let every source process the same invalidation before rebuilding the
      // open menu, so one source cannot contribute its previous catalog.
      void Promise.resolve().then(() => {
        if (this.disposed || this.hit !== hit || !this.menu.getSnapshot().open) return
        this.fetchCandidates(hit, this.deps.roster.sources(hit.trigger))
      })
    }))
  }

  /** Launch the candidate fetch for one hit generation, superseding the previous one. */
  private fetchCandidates(hit: TriggerHit, roster: readonly InputTriggerSource[]): void {
    this.stopFetch()
    const controller = new AbortController()
    this.fetch = controller
    const generation = this.menu.getSnapshot().generation
    const projection = this.project()
    for (const source of roster) {
      void source
        .candidates(projection, {
          query: hit.query,
          quoted: hit.quoted,
          position: hit.position,
          drilled: this.drilled,
          signal: controller.signal,
        })
        .then(
          (items) => {
            if (controller.signal.aborted) return
            this.reduce({ type: 'source-settled', generation, source: source.name, items })
          },
          (error: unknown) => {
            if (controller.signal.aborted) return
            console.error(`[ui-input-trigger] source "${source.name}" candidates failed:`, error)
            this.reduce({ type: 'source-failed', generation, source: source.name })
          },
        )
    }
  }

  private stopFetch(): void {
    this.fetch?.abort()
    this.fetch = null
  }

  /**
   * Run one candidate (or crumb) through its source and apply the outcome.
   *
   * A drill is the one pick that leaves the menu open, so it is also the one
   * that records how the next query was reached; every other pick closes the
   * menu, which clears that record.
   * @param src - the owning source.
   * @param candidate - the picked candidate, or a crumb projected as one.
   * @param hit - the authoritative hit supplying position and span CAS.
   * @param action - settling pick or drill.
   */
  private settle(
    src: InputTriggerSource,
    candidate: InputTriggerCandidate,
    hit: TriggerHit,
    action: PickAction,
  ): void {
    const outcome = src.onPick({
      candidate,
      session: this.project(),
      position: hit.position,
      via: 'menu',
      action,
      span: hit.span,
    })
    this.stopFetch()
    this.reduce({ type: 'close' })
    // Claimed before the edit, and after the close above so the reducer's own
    // teardown cannot clear it: the input may apply the descent through a
    // synchronous editor commit that re-enters track(), and the header and
    // candidate requests raised there read this flag. A refused edit (stale
    // draft revision, or an unmappable span) mutates nothing and so reaches
    // no re-entry, which is why withdrawing the claim afterwards still keeps
    // a header off a draft nobody descended into — one that would name a
    // directory while hiding the locations its rows still need.
    this.drilled = action === 'drill'
    if (!this.execute(outcome, hit.span)) this.drilled = false
  }

  /** Re-poll every header-bearing source in the hit roster and publish their crumbs. */
  private refreshHeaders(hit: TriggerHit, roster: readonly InputTriggerSource[]): void {
    const projection = this.project()
    const crumbs = new Map<string, readonly InputTriggerCrumb[]>()
    for (const src of roster) {
      if (src.header === undefined) continue
      let published: readonly InputTriggerCrumb[] | undefined
      try {
        published = src.header(projection, { query: hit.query, quoted: hit.quoted, drilled: this.drilled })
      } catch (error) {
        // A faulty source drops silently with a console record (the
        // candidate-fetch failure policy); a header is decoration and must
        // not take down the menu that carries the candidates.
        console.error(`[ui-input-trigger] source "${src.name}" header failed:`, error)
        continue
      }
      if (published === undefined || published.length === 0) continue
      crumbs.set(src.name, published)
    }
    this.setHeaders(crumbs)
  }

  private setHeaders(next: ReadonlyMap<string, readonly InputTriggerCrumb[]>): void {
    if (this.headers.getSnapshot().size === 0 && next.size === 0) return
    this.headers.set(next)
  }

  private clearLauncher(): void {
    if (this.launcher.getSnapshot() !== null) this.launcher.set(null)
  }

  private reduce(ev: MenuEvent): void {
    const cur = this.menu.getSnapshot()
    const next = menuReduce(cur, ev)
    if (next !== cur) this.menu.set(next)
    if (next.open) return
    this.clearLauncher()
    this.drilled = false
    this.setHeaders(new Map())
  }
}
