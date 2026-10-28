/**
 * Viewer-local plugin that reads the share the page presents and opens its one shared Session.
 *
 * The Liveshare client face mounts this plugin only on a viewer page, in place of the owner's Share
 * action. The share's own answer — who owns it and what mode it grants this page — is read here and
 * states the page's condition; which writes each Session offers comes from the calling Peer's access
 * snapshot, which every surface reads through its own access Hook.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-session-plugin
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the `remoteAccess` Client service merge.
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
// Type-only: pulls the `locale` Client service merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { openSharedSession } from './viewer-session.ts'
import {
  PAGE_WIDE_REFUSALS,
  resetViewerCapabilities,
  viewerCapabilities,
  type ViewerCapabilities,
} from './viewer-capabilities.ts'
import { readViewerContext, resetViewerContext } from './viewer-context.ts'
import { NS, viewerReasonText, type ViewerTranslate } from './locales.ts'
import { noteViewerStatusFacts, resetViewerStatus, viewerStatus } from './viewer-status.ts'
import { mountViewerStatusBanner, type ViewerStatusAction } from './viewer-status-banner.ts'

export const name = 'liveshare-viewer-session'

/**
 * The session list says when this page's Session exists, Workspace navigation selects it, the access
 * snapshot says which Sessions this page may prompt, and the Connection says whether reads reach the
 * owner.
 */
export const inject: readonly string[] = ['sessions', 'uiWorkspace', 'remoteAccess', 'connection', 'locale']

/**
 * Which mount of this plugin currently owns the page's module-level stores.
 *
 * The stores live at module scope so the viewer's slot seats read them without a service. Their owner
 * is the mount that created them: a mount clears them when it starts, and a disposal clears them only
 * while it is still the owning mount, so a replaced page's delayed teardown cannot wipe the state its
 * successor already read.
 */
let pageLifecycle = 0

/** Return the page's stores to the state a page that read nothing holds. */
function resetViewerPageState(): void {
  resetViewerContext()
  resetViewerCapabilities()
  resetViewerStatus()
}

/**
 * The Relay's sign-in entry, asked to return the reader to the page they left.
 *
 * A viewer page names its share in the query (`?shareId=...`), so the return address keeps the query
 * as well as the path: a sign-in that returned to the bare path would drop the share the reader is
 * signing in for. The fragment never leaves the page — a single-page app may keep a one-time
 * hand-off there — and the Relay accepts only a relay-relative path as a return address.
 * @param origin - Origin the Relay is served on.
 * @param basePath - Relay base path this page is served under.
 * @param page - The page's own path and query.
 * @returns The absolute sign-in entry carrying the page's return address.
 */
export function viewerSignInHref(
  origin: string,
  basePath: string,
  page: { readonly pathname: string; readonly search: string },
): string {
  const returnTo = `${page.pathname}${page.search}`
  return `${origin}${basePath}/__liveshare/auth/start?returnTo=${encodeURIComponent(returnTo)}`
}

/** Branch facts the owner host publishes for one Session, under its `forkLineage` projection key. */
interface ForkLineageFacts {
  readonly origin?: unknown
  readonly authoredByViewer?: unknown
}

/** Session list row facts this plugin reads: the projection values the Host published for it. */
interface ChildFacts {
  readonly projectionValues?: { readonly forkLineage?: ForkLineageFacts }
}

/**
 * Whether one listed Session is a branch this page created.
 * @param row - One session list row as the store publishes it.
 * @returns True when the Host published that row as this page's own branch.
 */
function isOwnFork(row: unknown): boolean {
  const lineage = (row as ChildFacts | undefined)?.projectionValues?.forkLineage
  return lineage?.origin === 'fork' && lineage.authoredByViewer === true
}

/** Session list face this plugin reads; only the members it uses are declared. */
interface SessionsView {
  readonly list: {
    getSnapshot(): {
      readonly byId: Readonly<Record<string, unknown>>
    }
    subscribe(observer: () => void): () => void
  }
  scope(sessionId: string): { get(name: string): unknown } | undefined
}

/** Session-scoped conversation face exposing the composer block registry. */
interface ConversationView {
  readonly blocks: { set(sessionId: string, block: ComposerBlock | undefined): void }
}

/**
 * Read the share, open the Session the served document names, and keep every composer honest.
 *
 * A viewer may read the shared Session and nothing else unless the owner grants more. The
 * framework's own composer block is the way to say that: while the access snapshot excludes
 * `session/prompt` for a Session, the block disables the input and renders the page's reason, and the
 * composer itself withholds Send and Stop, so the read-only transcript keeps streaming without a send
 * affordance. Page disposal cancels and awaits bootstrap, focus, and retry reads; late answers cannot
 * publish.
 * @param ctx - browser context of the viewer's module table.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const lifecycle = ++pageLifecycle
  // The plugin's fiber owns the page's stores: a page starts from the empty state, and a disposed or
  // HMR-replaced page releases what it read instead of leaving it for the next mount or the next share.
  resetViewerPageState()
  ctx.effect(() => () => {
    if (lifecycle !== pageLifecycle) return
    resetViewerPageState()
  }, 'liveshare: release the page state with its plugin')
  /* v8 ignore next -- the effect below assigns this before apply returns. */
  let refreshContext: () => void = () => {}
  /**
   * Perform the action one state offers, so no state ends at a statement the reader cannot act on.
   * @param action - Action the reader asked for.
   */
  const act = (action: ViewerStatusAction): void => {
    const target = (globalThis as {
      __DSH_LIVESHARE_VIEWER__?: { readonly shareId?: string; readonly basePath?: string }
    }).__DSH_LIVESHARE_VIEWER__
    const base = target?.basePath ?? ''
    if (action === 'reload') {
      location.reload()
      return
    }
    if (action === 'sign-in') {
      // The Relay owns the sign-in transaction; this page only sends the reader to it. The page's own
      // query is part of the address: it names the share the reader signed in for.
      location.href = viewerSignInHref(location.origin, base, location)
      return
    }
    if (action === 'directory') {
      location.href = `${location.origin}${base}/`
      return
    }
    // Retry: read the share's own answer again, which is what moves offline, unavailable, and
    // unconfirmed states forward. The page keeps stating the current state until a newer answer
    // replaces it.
    refreshContext()
  }
  // The page states its own condition. The client UI renders its shell whether or not the share can be
  // read, so a reader whose owner is offline, whose share ended, or whose sign-in lapsed would otherwise
  // see an empty page with no idea which of those it is.
  const banner = mountViewerStatusBanner(document, act, t)
  ctx.effect(() => {
    const paint = (): void => { banner.update(viewerStatus.getSnapshot()) }
    const stop = viewerStatus.subscribe(paint)
    // The statement is plain DOM rather than a slot-rendered surface, so it repaints from the locale
    // face itself when the reader's language changes.
    const stopLocale = ctx.locale.subscribe(paint)
    paint()
    return () => {
      stop()
      stopLocale()
      banner.dispose()
    }
  }, 'liveshare: state why the page shows no Session')
  // A Connection that lost its carrier cannot read the Session right now; the Connection layer
  // reconnects by itself, so the page states `offline` until a generation is connected again.
  ctx.effect(() => {
    const state = (ctx.get('connection') as ConnectionHandle).state
    const note = (): void => {
      const current = state.getSnapshot()
      if (current === 'connected') noteViewerStatusFacts({ feedFailed: false })
      else if (current === 'disconnected') noteViewerStatusFacts({ feedFailed: true })
    }
    const stop = state.subscribe(note)
    note()
    return stop
  }, 'liveshare: state a lost Connection as offline')
  const target = (globalThis as {
    __DSH_LIVESHARE_VIEWER__?: {
      readonly shareId?: string
      readonly sessionId?: string
      readonly basePath?: string
    }
  }).__DSH_LIVESHARE_VIEWER__
  // The share's own answer says who owns it and what it grants this page. It arrives when it arrives:
  // every surface re-reads it, so the Session opens as soon as the list carries it rather than waiting
  // for an answer that a stalled Relay may never send.
  ctx.effect(() => {
    const lifetime = new AbortController()
    const reads = new Set<Promise<void>>()
    const readContext = (): Promise<void> => {
      const read = readViewerContext(target?.basePath ?? '', target?.shareId ?? '', lifetime.signal)
      reads.add(read)
      void read.finally(() => { reads.delete(read) })
      return read
    }
    const refresh = (): void => { if (!document.hidden) void readContext() }
    refreshContext = () => { void readContext() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    void readContext()
    return async () => {
      /* v8 ignore next -- a disposed page's banner is removed with its action listeners. */
      refreshContext = () => {}
      lifetime.abort()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      await Promise.all(reads)
    }
  }, 'liveshare: re-read the share when the reader returns')
  openSharedSession(ctx)
  const sessionId = target?.sessionId
  if (sessionId === undefined || sessionId === '') return
  const sessions = ctx.get('sessions') as SessionsView | undefined
  /* v8 ignore next -- `sessions` is in this plugin's inject list, so apply runs only once it exists. */
  if (sessions === undefined) return
  /**
   * Keep every composer on this page honest. Each Session states what this page holds for it: the
   * Sessions the page presents or created, plus whatever Session the reader has switched to, so a
   * switch to a Session whose reach the page has not read states that fact instead of inheriting the
   * answers of the Session it came from.
   *
   * Only the Sessions this page presents, created, or has switched to are addressed: reading a scope
   * materializes one for any listed Session, and a page that may not write a row has no business
   * building a scope for every row it can list.
   * @param follow - Subscribe to one addressed Session's prompt answer.
   */
  const syncBlocks = (follow: (sessionId: string) => HostObservable<boolean>, tracked: Set<string>): void => {
    const snapshot = sessions.list.getSnapshot()
    const addressed = new Set<string>([sessionId])
    // The main view's own retain count is what says which Session the reader has selected.
    const current = Object.values(snapshot.byId)
      .find(row => ((row as { readonly retainedBy?: { readonly mainView?: number } }).retainedBy?.mainView ?? 0) > 0)
    if (current !== undefined) addressed.add((current as { readonly id: string }).id)
    for (const listed of Object.keys(snapshot.byId)) {
      if (isOwnFork(snapshot.byId[listed])) addressed.add(listed)
    }
    for (const listed of addressed) {
      tracked.add(listed)
      const prompt = follow(listed)
      const conversation = sessions.scope(listed)?.get('conversation') as ConversationView | undefined
      if (conversation === undefined) continue
      // A Session this page may prompt carries no block: the branch it created, and in write mode also
      // the Session the owner opened.
      if (prompt.getSnapshot()) {
        conversation.blocks.set(listed, undefined)
        continue
      }
      conversation.blocks.set(listed, {
        reason: blockReason(listed === sessionId, isOwnFork(snapshot.byId[listed]), viewerCapabilities.getSnapshot(), t),
      })
    }
  }
  ctx.effect(() => {
    const followed = new Map<string, () => void>()
    // The Sessions this effect addressed, so disposal can clear every block it raised instead of leaving
    // the page's composers blocked after the plugin is gone.
    const tracked = new Set<string>()
    const publish = (): void => { syncBlocks(follow, tracked) }
    const follow = (id: string): HostObservable<boolean> => {
      const source = ctx.remoteAccess.source('session', id, 'session/prompt')
      if (!followed.has(id)) followed.set(id, source.subscribe(publish))
      return source
    }
    const stopList = sessions.list.subscribe(publish)
    const stopCapabilities = viewerCapabilities.subscribe(publish)
    publish()
    return () => {
      stopList()
      stopCapabilities()
      for (const stop of followed.values()) stop()
      for (const listed of tracked) {
        const conversation = sessions.scope(listed)?.get('conversation') as ConversationView | undefined
        conversation?.blocks.set(listed, undefined)
      }
    }
  }, 'liveshare: keep the viewer composer honest')
}

/**
 * Reason one Session's composer states while this page may not prompt it.
 *
 * The access snapshot answers only whether a Session may be prompted, so the reason comes from the
 * page's own share answer: a Session's own refusal code does not reach the page.
 * @param isSource - Whether this is the Session the share was made for.
 * @param isOwnFork - Whether this is a branch this page created.
 * @param page - What the share's own answer grants this page, and the code behind it when it named one.
 * @returns The reason text the blocked composer states.
 */
function blockReason(
  isSource: boolean,
  isOwnFork: boolean,
  page: ViewerCapabilities,
  t: ViewerTranslate,
): string {
  const reason = page.reason
  // A share whose answer never arrived is not confirmed to be read-only: the page states that it
  // cannot confirm the share's state, and neither claims the share was stopped nor presents an access
  // it was never told it still has.
  if (page.unconfirmed === true) return viewerReasonText(t, 'unconfirmed')
  // A share that is gone, or one this reader was removed from, is the reader's real reason, on the
  // shared Session and on every branch of it.
  if (reason !== undefined && PAGE_WIDE_REFUSALS.has(reason)) return viewerReasonText(t, reason)
  // A branch this page made is driven in either tier, so a snapshot that still refuses its prompt means
  // the branch itself lost its grant: the owner turned the share's fork switch off, or withdrew the
  // share that carried it. The page states that fork verdict — with the code the share named when it
  // named one — rather than the read-only note, which would claim a reach this Session no longer has.
  if (!isSource && isOwnFork) return viewerReasonText(t, reason ?? 'fork-not-permitted')
  // The share grants writing this Session, and nothing above explains the blocked composer: the missing
  // permission is not the reason, so the page states the narrower fact instead of claiming the share is
  // read-only. The owner's own code for it — `source-write-unavailable` — is not published with the share
  // answer, so this build names the state without it rather than inventing one.
  if (isSource && page.mode === 'write') return t('viewer.writeUnavailableNote')
  return t('viewer.readonlyNote')
}
