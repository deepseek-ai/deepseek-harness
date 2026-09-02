/** Per-Session target-neutral Conversation assembly. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  ISessions, SessionBinding, SessionEventSource, SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createSnapshotStore, type ObservableSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type {
  ConversationPublication, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore,
} from '../contract/conversation.ts'
import type { ConversationSnapshot } from '../contract/snapshot.ts'
import type { ConversationPromptSnapshot, RequestPromptInspection } from '../contract/request-inspection.ts'
import { inspectRequestPrompt } from '../contract/request-inspection.ts'
import { ConversationNodeAssembler } from './assembler.ts'
import { ConversationEventRegistry } from './event-registry.ts'
import { HistoricalImageCache } from './historical-images.ts'
import { ConversationViewRegistry } from './view-registry.ts'

/** Observable faces published for one Session's Conversation assembly. */
export interface ConversationBinding {
  readonly snapshot: ObservableSnapshot<ConversationSnapshot>
  /**
   * Add one selected target to the Session's monotonic active set.
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
  private readonly viewStore: ConversationViewSnapshotStore
  private readonly targetSources = new Map<string, ObservableSnapshot<unknown>>()
  private revision = -1
  private frame: number | undefined
  private disposeFeed: () => void = () => {}

  constructor(
    feed: SessionEventSource,
    private readonly assembler: ConversationNodeAssembler,
  ) {
    this.viewStore = assembler
    this.snapshot = createSnapshotStore(this.currentSnapshot())
    this.replace(feed.getSnapshot())
    this.disposeFeed = feed.subscribe(() => {
      this.accept(feed.getSnapshot())
    })
  }

  target<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined> {
    let source = this.targetSources.get(target)
    if (source === undefined) {
      const views = this.viewStore as unknown as { get(key: string): unknown }
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
    if (this.assembler.activateTarget(target)) this.snapshot.set(this.currentSnapshot())
  }

  rebuild(): void { this.publish(this.assembler.rebuildRegistry()) }

  dispose(): void {
    this.cancelFrame()
    this.disposeFeed()
  }

  private replace(window: SessionEventWindow): void {
    this.revision = window.revision
    this.publish(this.assembler.replaceWindow(window.entries, window.hasMore))
  }

  private accept(window: SessionEventWindow): void {
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
      }
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
    if (this.assembler.flush()) this.snapshot.set(this.currentSnapshot())
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
  private readonly bindings = new Map<SessionId, BindingRecord>()
  private readonly images: HistoricalImageCache

  /**
   * @param ctx - owning Client context.
   * @param sessions - Session Controller object layer.
   */
  constructor(ctx: Context, private readonly sessions: ISessions) {
    super(ctx, 'uiConversation')
    this.events = new ConversationEventRegistry(ctx)
    this.views = new ConversationViewRegistry(ctx)
    this.images = new HistoricalImageCache(ctx, sessions)
    const rebuild = (): void => {
      for (const record of this.bindings.values()) record.binding.rebuild()
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
      return () => {
        disposeViews()
        disposeEvents()
        for (const record of [...this.bindings.values()]) this.drop(record, true)
      }
    }, 'ui-conversation assembly')
  }

  /**
   * Resolve the Conversation binding for one Controller binding or Session id.
   * @param source - Session binding or identity.
   * @returns stable Conversation binding.
   */
  binding(source: SessionBinding | SessionId): ConversationBinding {
    const sessionId = typeof source === 'string' ? source : source.sessionId
    const owner = typeof source === 'string' ? this.sessions.binding(source) : source
    if (owner === undefined) throw new Error(`uiConversation.binding: unknown session "${sessionId}"`)
    const current = this.bindings.get(owner.sessionId)
    if (current?.source === owner) return current.binding
    if (current !== undefined) this.drop(current, true)
    const binding = new BoundConversation(
      owner.eventSource,
      new ConversationNodeAssembler(this.events, this.views),
    )
    const record: BindingRecord = { source: owner, binding, disposeScope: () => {} }
    this.bindings.set(owner.sessionId, record)
    const disposeScope = owner.ctx.effect(
      () => () => { this.drop(record, false) },
      'ui-conversation binding',
    )
    record.disposeScope = () => { void disposeScope() }
    return binding
  }

  /**
   * Resolve one session-authorized durable image URL, cached per Session so
   * every Conversation target shares one read and one browser URL.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference from a session event.
   * @returns browser URL valid until the Session binding is released.
   */
  imageUrl(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    return this.images.resolve(sessionId, attachment)
  }

  /**
   * Read a cached durable image URL synchronously when one is available.
   * @param sessionId - Session authorization and lifetime scope.
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
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference the URL displays.
   * @param url - browser URL to adopt.
   * @returns whether the cache took URL ownership.
   */
  seedImageUrl(sessionId: SessionId, attachment: ImageAttachmentRef, url: string): boolean {
    return this.images.seed(sessionId, attachment, url)
  }

  /**
   * Canonicalize one `request/header` event against the previous prompt state.
   *
   * A pure interpretation shared by the Chat and Trajectory Definitions, exposed
   * as a service method because cross-plugin value imports are forbidden in
   * client bundles.
   * @param previous - prompt recorded by the preceding loaded header, if any.
   * @param event - the `request/header` session event to interpret.
   * @returns the canonical prompt snapshot and any model-visible change.
   */
  inspectRequestPrompt(
    previous: ConversationPromptSnapshot | undefined,
    event: SessionEvent<'request/header'>,
  ): RequestPromptInspection {
    return inspectRequestPrompt(previous, event)
  }

  private drop(record: BindingRecord, releaseScope: boolean): void {
    if (this.bindings.get(record.source.sessionId) !== record) return
    this.bindings.delete(record.source.sessionId)
    record.binding.dispose()
    if (releaseScope) record.disposeScope()
  }
}
