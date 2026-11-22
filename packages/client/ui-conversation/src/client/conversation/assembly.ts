/** Per-Session target-neutral Conversation assembly. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  ISessions, SessionBinding, SessionEventSource, SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import {
  createSnapshotStore, type ObservableSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type {
  ConversationPublication, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore,
} from '../contract/conversation.ts'
import type { ConversationSnapshot } from '../contract/snapshot.ts'
import type {
  ConversationPromptSnapshot, RequestPromptInspection, SystemPromptNode,
} from '../contract/request-inspection.ts'
import { inspectRequestPrompt } from '../contract/request-inspection.ts'
import { inspectSystemPrompt, type SystemPromptState } from '../contract/system-prompt.ts'
import { ConversationNodeAssembler, ConversationUpdateError } from './assembler.ts'
import { ConversationEventRegistry } from './event-registry.ts'
import { HistoricalImageCache } from './historical-images.ts'
import { ConversationViewRegistry } from './view-registry.ts'
import { ConversationGroupRegistry } from './group-registry.ts'
import { ConversationInteractionRegistry } from './interaction-registry.ts'
import { UserTextRegistry } from './user-text-registry.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionRetainFacetMap {
    /**
     * Conversation assembly of the Session's event window. While a reference retains it, the binding folds the
     * window and follows its changes; when the last such reference is released, the binding drops the fold and
     * publishes the empty result, and retaining it again folds the current window once.
     */
    conversation: unknown
  }
}

/**
 * Observable faces published for one Session's Conversation assembly. Every face follows the
 * Session only while a reference retains the `conversation` facet.
 */
export interface ConversationBinding {
  readonly snapshot: ObservableSnapshot<ConversationSnapshot>
  /**
   * Identity-stable source of the latest turn number, undefined unless its start is loaded and it remains open.
   * Turn changes publish synchronously while the facet is retained, including without an active View.
   */
  readonly openTurn: ObservableSnapshot<number | undefined>
  /**
   * Add one selected target to the Session's monotonic active set; while the facet is not retained,
   * the target's view stays empty until retention folds the window.
   * @param target - registered or subsequently registered Conversation target.
   */
  activate(target: string): void
  /**
   * Resolve one target-owned snapshot source.
   * The first subscriber activates the target unless shell selection already
   * activated it; activation lasts for the remaining Session lifetime.
   * @param target - registered Conversation target.
   * @returns identity-stable source following the target.
   */
  target<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined>
}

class BoundConversation implements ConversationBinding {
  readonly snapshot: SnapshotStore<ConversationSnapshot>
  readonly openTurn: SnapshotStore<number | undefined>
  private readonly viewStore: ConversationViewSnapshotStore
  private readonly targetSources = new Map<string, ObservableSnapshot<unknown>>()
  private revision = -1
  private frame: number | undefined
  private following = false
  /** Whether the assembler holds the window at `revision`; a failed fold leaves nothing to extend incrementally. */
  private folded = false
  private disposeFeed: () => void = () => {}
  private disposeRetained: () => void = () => {}

  /**
   * @param feed - the Session's contiguous event window.
   * @param assembler - this binding's Node assembler.
   * @param retained - whether any reference retains the `conversation` facet; assembly follows the feed only while true.
   */
  constructor(
    private readonly feed: SessionEventSource,
    private readonly assembler: ConversationNodeAssembler,
    private readonly retained: ObservableSnapshot<boolean>,
  ) {
    this.viewStore = assembler
    this.snapshot = createSnapshotStore(this.currentSnapshot())
    this.openTurn = createSnapshotStore(assembler.openTurn())
  }

  /**
   * Begin following facet retention; the owner registers this binding's disposal first,
   * so subscriptions acquired before a failed initial fold still have an owner.
   */
  start(): void {
    this.disposeRetained = this.retained.subscribe(() => { this.follow(this.retained.getSnapshot()) })
    this.follow(this.retained.getSnapshot())
  }

  target<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined> {
    let source = this.targetSources.get(target)
    if (source === undefined) {
      const views = this.viewStore as { get(key: string): unknown }
      source = {
        getSnapshot: () => views.get(target),
        subscribe: (listener) => {
          const unsubscribe = this.snapshot.subscribe(listener)
          this.activate(target)
          return unsubscribe
        },
      }
      this.targetSources.set(target, source)
    }
    return source as ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined>
  }

  activate(target: string): void {
    this.publishing(() => this.assembler.activateTarget(target))
  }

  rebuild(): void {
    // A binding that does not follow holds no fold; following again rebuilds against the current registry.
    if (!this.following) return
    this.publish(this.assembler.rebuildRegistry())
  }

  dispose(): void {
    this.following = false
    this.disposeRetained()
    this.cancelFrame()
    this.disposeFeed()
  }

  /**
   * Start or stop following the feed. Starting folds the whole current window and publishes it at once;
   * stopping drops the fold and publishes the empty result.
   */
  private follow(retained: boolean): void {
    if (retained === this.following) return
    this.following = retained
    this.cancelFrame()
    if (!retained) {
      this.disposeFeed()
      this.disposeFeed = () => {}
      this.folded = false
      this.publishing(() => {
        this.assembler.rebuildRegistry([], false)
        return this.assembler.flush()
      })
      return
    }
    // A dispatch already in progress keeps a copy of its listeners, so the callback checks
    // whether the binding still follows rather than relying on unsubscription alone.
    this.disposeFeed = this.feed.subscribe(() => {
      if (this.following) this.accept(this.feed.getSnapshot())
    })
    this.foldWindow()
  }

  /** Fold the whole current window against the current registry and publish it synchronously. */
  private foldWindow(): void {
    const window = this.feed.getSnapshot()
    this.folded = false
    this.cancelFrame()
    this.publishing(() => {
      this.assembler.rebuildRegistry(window.entries, window.hasMore)
      this.revision = window.revision
      this.folded = true
      return this.assembler.flush()
    })
  }

  private replace(window: SessionEventWindow): void {
    this.revision = window.revision
    this.publish(this.assembler.replaceWindow(window.entries, window.hasMore))
  }

  private accept(window: SessionEventWindow): void {
    if (!this.folded) {
      this.foldWindow()
      return
    }
    if (window.revision === this.revision) return
    if (window.revision !== this.revision + 1 || window.change.kind === 'replace') {
      this.replace(window)
      return
    }
    this.revision = window.revision
    switch (window.change.kind) {
      case 'prepend':
        this.publish(this.assembler.prepend(window.change.entries, window.hasMore))
        return
      case 'append': {
        let publication: ConversationPublication = 'none'
        for (const event of window.change.entries) {
          const next = this.assembler.append(event)
          if (next === 'immediate' || publication === 'none') publication = next
        }
        this.publish(publication)
        return
      }
      case 'settle-assistant':
        this.publish(this.assembler.settleAssistant(
          window.change.attemptId,
          window.change.entry,
        ))
        return
    }
  }

  private publish(publication: ConversationPublication): void {
    if (publication === 'none') return
    if (publication === 'animation-frame' && typeof requestAnimationFrame === 'function') {
      if (this.frame !== undefined) return
      // Cross three paint opportunities before publishing high-frequency stream updates.
      this.frame = requestAnimationFrame(() => {
        this.frame = requestAnimationFrame(() => {
          this.frame = requestAnimationFrame(() => {
            this.frame = undefined
            this.flush()
          })
        })
      })
      return
    }
    this.cancelFrame()
    this.flush()
  }

  private cancelFrame(): void {
    if (this.frame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.frame)
    }
    this.frame = undefined
  }

  private flush(): void {
    this.publishing(() => this.assembler.flush())
  }

  /** Publish an assembler result, including a complete rebuild that the assembler finished before it reported a failure. */
  private publishing(operation: () => boolean): void {
    let changed: boolean
    try {
      changed = operation()
    } catch (error: unknown) {
      if (error instanceof ConversationUpdateError && error.rebuilt) this.publishSnapshot(true)
      throw error
    }
    this.publishSnapshot(changed)
  }

  private publishSnapshot(changed: boolean): void {
    if (changed) this.snapshot.set(this.currentSnapshot())
    this.openTurn.set(this.assembler.openTurn())
  }

  private currentSnapshot(): ConversationSnapshot {
    return {
      views: this.viewStore,
      activeTargets: this.assembler.activityTargets(),
    }
  }
}

interface BindingRecord {
  readonly source: SessionBinding
  readonly binding: BoundConversation
  disposeScope: () => void
}

/** Root service owning Conversation registries and per-Session bindings. */
export class UiConversation extends Service {
  /** Registry of event matchers and target snapshot builders. */
  readonly events: ConversationEventRegistry
  /** Registry of target View definitions. */
  readonly views: ConversationViewRegistry
  /** Business grouping rules over already materialized target Nodes. */
  readonly groups: ConversationGroupRegistry
  /** Pure text rules and parser snapshots, independent of durable Session assembly. */
  readonly userText: UserTextRegistry
  /** Plugin-owned handlers for selection and context-menu gestures. */
  readonly interactions: ConversationInteractionRegistry
  private readonly bindings = new WeakMapWithValues<SessionBinding, BindingRecord>()
  private readonly images: HistoricalImageCache

  /**
   * @param ctx - owning Client context.
   * @param sessions - Session Controller object layer.
   */
  constructor(ctx: Context, private readonly sessions: ISessions) {
    super(ctx, 'uiConversation')
    this.events = new ConversationEventRegistry(ctx)
    this.views = new ConversationViewRegistry(ctx)
    this.groups = new ConversationGroupRegistry(ctx, this.views)
    this.userText = new UserTextRegistry(ctx)
    this.interactions = new ConversationInteractionRegistry(ctx)
    this.images = new HistoricalImageCache(ctx, sessions)
    const rebuild = (): void => {
      for (const record of this.bindings.values) record.binding.rebuild()
    }
    let rebuildQueued = false
    const scheduleRebuild = (): void => {
      if (rebuildQueued) return
      rebuildQueued = true
      queueMicrotask(() => {
        rebuildQueued = false
        rebuild()
      })
    }
    ctx.effect(() => {
      const disposeEvents = this.events.subscribe(scheduleRebuild)
      const disposeViews = this.views.subscribe(scheduleRebuild)
      const disposeGroups = this.groups.subscribe(scheduleRebuild)
      return () => {
        disposeGroups()
        disposeViews()
        disposeEvents()
        for (const record of [...this.bindings.values]) this.drop(record, true)
      }
    }, 'ui-conversation assembly')
  }

  /**
   * Resolve the Conversation binding for one Controller binding or Session id.
   * @param source - Session binding or identity.
   * @returns stable Conversation binding.
   * @throws if the Session is unknown or its binding is no longer current.
   */
  binding(source: SessionBinding | SessionId): ConversationBinding {
    const sessionId = typeof source === 'string' ? source : source.sessionId
    const owner = typeof source === 'string' ? this.sessions.binding(source) : source
    if (owner === undefined) throw new Error(`uiConversation.binding: unknown session "${sessionId}"`)
    if (this.sessions.binding(sessionId) !== owner) {
      throw new Error(`uiConversation.binding: inactive session "${sessionId}"`)
    }
    const current = this.bindings.get(owner)
    if (current !== undefined) return current.binding
    const binding = new BoundConversation(
      owner.eventSource,
      new ConversationNodeAssembler(this.events, this.views, this.groups),
      this.retainedConversation(owner),
    )
    const record: BindingRecord = { source: owner, binding, disposeScope: () => {} }
    this.bindings.set(owner, record)
    const disposeScope = owner.ctx.effect(
      () => () => { this.drop(record, false) },
      'ui-conversation binding',
    )
    record.disposeScope = () => { void disposeScope() }
    try {
      binding.start()
    } catch (error: unknown) {
      // A failed initial fold leaves no binding behind, so the next resolution starts afresh.
      this.drop(record, true)
      throw error
    }
    return binding
  }

  /**
   * Whether a reference retains the `conversation` facet of this exact binding; a same-id
   * replacement generation's counts do not apply to a binding that is no longer current.
   */
  private retainedConversation(owner: SessionBinding): ObservableSnapshot<boolean> {
    const info = this.sessions.retainInfo(owner.sessionId)
    return {
      getSnapshot: () => this.sessions.binding(owner.sessionId) === owner
        && (info.getSnapshot().retainedFacets?.conversation ?? 0) > 0,
      subscribe: listener => info.subscribe(listener),
    }
  }

  /**
   * Resolve one Gateway-authorized durable image URL, cached per Session so
   * every Conversation target shares one read and one browser URL.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference from a session event.
   * @returns browser URL valid until the Session binding is released.
   */
  imageUrl(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    return this.images.resolve(sessionId, attachment)
  }

  /**
   * Read a cached durable image URL synchronously when one is available.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference from a session event.
   * @returns current preview or canonical URL, if cached.
   */
  peekImageUrl(sessionId: SessionId, attachment: ImageAttachmentRef): string | undefined {
    return this.images.peek(sessionId, attachment)
  }

  /**
   * Adopt an already-displayable URL for one durable reference (see
   * HistoricalImageCache.seed): the transcript node then renders it without a
   * byte round-trip.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference the URL displays.
   * @param url - browser URL to adopt.
   * @returns whether the cache took URL ownership.
   */
  seedImageUrl(sessionId: SessionId, attachment: ImageAttachmentRef, url: string): boolean {
    return this.images.seed(sessionId, attachment, url)
  }

  /**
   * Interpret a system message or surface replacement for target-owned prompt Definitions.
   * @param previous - System facts at the preceding relevant loaded event.
   * @param event - Durable system message or positional replacement.
   * @returns Immutable prompt interpretation at this event.
   */
  inspectSystemPrompt(previous: SystemPromptState | undefined, event: SessionEvent): SystemPromptState {
    return inspectSystemPrompt(previous, event)
  }

  /**
   * Canonicalize one `request/header` event against the previous prompt state
   * and the `system/message` node in force.
   *
   * A pure interpretation shared by the Chat and Trajectory Definitions, exposed
   * as a service method because cross-plugin value imports are forbidden in
   * client bundles.
   * @param previous - prompt recorded by the preceding loaded header, if any.
   * @param event - the `request/header` session event to interpret.
   * @param system - effective prompt after loaded surface replacements, if any.
   * @returns the canonical prompt snapshot and any model-visible change.
   */
  inspectRequestPrompt(
    previous: ConversationPromptSnapshot | undefined,
    event: SessionEvent<'request/header'>,
    system: SystemPromptNode | undefined,
  ): RequestPromptInspection {
    return inspectRequestPrompt(previous, event, system)
  }

  private drop(record: BindingRecord, releaseScope: boolean): void {
    if (this.bindings.get(record.source) !== record) return
    this.bindings.delete(record.source)
    record.binding.dispose()
    if (releaseScope) record.disposeScope()
  }
}
