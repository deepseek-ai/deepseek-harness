/** Right-Sidebar presentation of an existing subagent or dragged root Session Conversation. */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionReference, SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { ConversationViewsProps, WorkspaceSelectedHandler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PaneId, SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {
  HostObservable, PropsRenderFactories, PropsRenderSlots, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { NS } from '../locales.ts'
import css from './SidebarChat.module.css'
import {
  SESSION_DRAG_TYPE, SessionDropZone, type SessionDrag, type SessionDropTarget, type SessionDropZoneInjected,
} from './SessionDropZone.tsx'

/** Stable implementation identity for the Sidebar tab body. */
export const SUBAGENT_CHAT_ID = '@deepseek-ai/dsh-client-ui-subagent'

/** Resource-address prefix for an embedded Session chat. */
export const SUBAGENT_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/'

/** Value retained by one live chat resource occurrence. */
export interface SubagentChatResource {
  readonly address: SessionTarget
  readonly reference: SessionReference
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    sidebarChat: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface ResourceProtocolMap {
    subagentchat: SubagentChatResource
  }

  interface SlotMap {
    /** Session-scoped Conversation occurrence hosted by one Sidebar chat tab. */
    'sidebar.chat.conversation': { kind: 'single'; scope: 'session'; inject: SidebarChatInjected }
  }
}

/**
 * Address one subagent Session together with the routing facts needed to restore it.
 * @param address - durable direct-parent subagent address.
 * @returns canonical Sidebar resource address.
 */
export function subagentChatAddress(address: SubagentAddress): string {
  const query = new URLSearchParams({
    parent: address.parentSessionId,
    mode: address.mode,
  })
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(address.childSessionId)}?${query}`
}

/**
 * Address one root Session, which carries no routing query.
 * @param sessionId - Session dragged from the Session list.
 * @returns canonical Sidebar resource address.
 */
export function sessionChatAddress(sessionId: SessionId): string {
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(sessionId)}`
}

/**
 * Parse one canonical Sidebar chat resource address.
 * @param value - possible chat resource address.
 * @returns the encoded direct-parent address, the root Session id of an address without a query,
 * or undefined for another or malformed resource.
 */
export function parseSubagentChatAddress(value: string): SessionTarget | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (_invalidUrl) {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'subagentchat') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  let sessionId: SessionId
  try {
    sessionId = decodeURIComponent(parts[1] as string) as SessionId
  } catch (_invalidEncoding) {
    return undefined
  }
  if (url.search === '') return sessionId
  const parentSessionId = url.searchParams.get('parent')
  const mode = url.searchParams.get('mode')
  if (parentSessionId === null || parentSessionId === '' || (mode !== 'one-shot' && mode !== 'continuable' && mode !== 'unknown')) {
    return undefined
  }
  return { parentSessionId: parentSessionId as SessionId, childSessionId: sessionId, mode }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function isAbortRequested(signal: AbortSignal): boolean {
  return signal.aborted
}

function subagentChatResourceProvider(sessions: ISessions): ResourceProvider<'subagentchat'> {
  return {
    protocol: 'subagentchat',
    async *open(resourceAddress, { signal }) {
      const address = parseSubagentChatAddress(resourceAddress)
      if (address === undefined) throw new Error(`ui-subagent: invalid chat resource address "${resourceAddress}"`)
      if (isAbortRequested(signal)) return
      const reference = sessions.retain(address, { source: 'sidebarChat', facets: { conversation: true }, signal })
      try {
        yield { ok: true, value: { address, reference } }
        await waitForAbort(signal)
      } finally {
        reference.release()
      }
    },
  }
}

/**
 * Find the frame column holding a dragged row: the frame's child that is a sibling of its overlay layer.
 * @param node - drag source.
 * @returns the left navigation column, or undefined outside the frame.
 */
function frameColumnOf(node: Element): Element | undefined {
  for (let element = node, parent = node.parentElement; parent !== null; element = parent, parent = parent.parentElement) {
    if (parent.querySelector(':scope > [data-shell-overlay]') !== null) return element
  }
  return undefined
}

/**
 * Measure where a dragged Session can land in the on-screen Session's right Sidebar.
 * @param doc - document holding the frame.
 * @param onScreen - the Session whose Sidebar receives the drop.
 * @param column - navigation column the row left; the target never reaches left of it.
 * @returns one target per docked pane while the Sidebar is open, else the area the Sidebar would open in.
 */
function dropTargets(doc: Document, onScreen: SessionId, column: Element | undefined): SessionDropTarget[] {
  const inset = Math.round(column?.getBoundingClientRect().right ?? 0)
  const panel = [...doc.querySelectorAll('[data-sidebar-right-panel]')]
    .find(element => element.getAttribute('data-sidebar-right-session') === onScreen)
  if (panel?.hasAttribute('data-sidebar-right-open') === true) {
    const panes = [...panel.querySelectorAll('[data-dockkit-pane]')].flatMap((pane) => {
      const rect = pane.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? [{ paneId: pane.getAttribute('data-dockkit-pane') as PaneId, rect }] : []
    })
    if (panes.length > 0) {
      return panes.map(({ paneId, rect }) => ({
        paneId, left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
      }))
    }
  }
  // A collapsed panel keeps its resolved width; zero means it cannot fit beside the conversation.
  const viewport = doc.documentElement.clientWidth
  const width = Math.round(panel?.getBoundingClientRect().width ?? 0)
  const left = Math.max(inset, width > 0 ? viewport - width : inset)
  const top = Math.round(column?.getBoundingClientRect().top ?? 0)
  return [{ left, top, width: Math.max(0, viewport - left), height: Math.max(0, doc.documentElement.clientHeight - top) }]
}

/**
 * Track Session rows dragged from the Session list while another Session is on screen.
 * @param doc - document whose drag events carry the rows' data.
 * @param mounted - reads the on-screen Session.
 * @returns the dragged Session with its drop targets, and the listener disposer.
 */
export function trackSessionDrags(doc: Document, mounted: () => SessionId | undefined): {
  readonly source: HostObservable<SessionDrag | undefined>
  readonly dispose: () => void
} {
  let current: SessionDrag | undefined
  const listeners = new Set<() => void>()
  const publish = (next: SessionDrag | undefined): void => {
    if (next === current) return
    current = next
    for (const listener of listeners) listener()
  }
  // The row's React handler has set the drag data by the time dragstart bubbles here.
  const start = (event: DragEvent): void => {
    const id = event.dataTransfer?.getData(SESSION_DRAG_TYPE) as SessionId | undefined
    const onScreen = mounted()
    if (id === undefined || id === '' || onScreen === undefined || onScreen === id) {
      publish(undefined)
      return
    }
    publish({ sessionId: id, targets: dropTargets(doc, onScreen, frameColumnOf(event.target as Element)) })
  }
  const end = (): void => { publish(undefined) }
  // A source row unmounted mid-drag fires dragend on a detached node; the first
  // button-free mouse move after the drag clears the zone instead.
  const move = (event: MouseEvent): void => { if (event.buttons === 0) end() }
  doc.addEventListener('dragstart', start)
  doc.addEventListener('dragend', end)
  doc.addEventListener('drop', end)
  doc.addEventListener('mousemove', move)
  return {
    source: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    dispose: () => {
      doc.removeEventListener('dragstart', start)
      doc.removeEventListener('dragend', end)
      doc.removeEventListener('drop', end)
      doc.removeEventListener('mousemove', move)
    },
  }
}

/** Navigation injected into the child-Session Conversation host. */
export interface SidebarChatInjected {
  /** Open the Workspace's blank Session as the main Session. */
  readonly openWorkspace: WorkspaceSelectedHandler
}

/** Fixed Chat selection used by an embedded Conversation occurrence. */
export function FixedChatConversationView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Props supplied to the child-Session Conversation host. */
export type ConversationSlotPanelProps = PropsRuntime<'sidebar.chat.conversation'> & PropsRenderFactories

/** Render the shared Conversation content for one explicitly provided child Session. */
export function ConversationSlotPanel({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot, openWorkspace,
}: ConversationSlotPanelProps) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true)
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero, onWorkspaceSelected: openWorkspace }, {
    slots: { views: FixedChatConversationView },
  })
}

/** Props supplied to the parent-Session Sidebar tab body. */
export type SidebarChatTabProps =
  PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'sidebar.chat.conversation'>

/** Bind a chat resource's child reference around its Conversation slot. */
export function SidebarChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }: SidebarChatTabProps) {
  const { tab } = useTabInfo()
  const resource = useResource<'subagentchat'>(tab.contentId)
  return (
    <div className={css.root} data-sidebar-chat="">
      {resource.value === undefined
        ? null
        : (
          <SessionProvider session={resource.value.reference}>
            {renderSlot('sidebar.chat.conversation', {})}
          </SessionProvider>
        )}
    </div>
  )
}

/**
 * Register the chat resource owner and its right-Sidebar presentation.
 * @param ctx - Client root carrying Sessions, resources, Slots, and Sidebar registries.
 * @param t - Chat namespace translator used for fallback tab titles.
 */
export function registerSidebarChat(ctx: Context, t: TranslateNS<typeof NS>): void {
  ctx.effect(
    () => ctx.resources.register(subagentChatResourceProvider(ctx.sessions)),
    'ui-subagent: Sidebar chat resources',
  )
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SUBAGENT_CHAT_ID,
    kind: 'subagentchat',
    patterns: [`${SUBAGENT_CHAT_ADDRESS}**`],
    priority: 'builtin',
    canOpen: address => parseSubagentChatAddress(address) !== undefined,
    title: (address) => {
      const target = parseSubagentChatAddress(address)
      if (target === undefined) return t('sidebar.chat')
      const id = typeof target === 'string' ? target : target.childSessionId
      const summary = ctx.sessions.list.getSnapshot().byId[id]
      return summary?.projectionValues?.subagent?.label ?? summary?.displayTitle ?? id
    },
  } satisfies SidebarRightTabDefinition), 'ui-subagent: Sidebar chat type')
  const chatInjected: SidebarChatInjected = {
    openWorkspace: (workspaceId, adopt) => ctx.uiWorkspace.openWorkspace(workspaceId, adopt),
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SUBAGENT_CHAT_ID,
    children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session', inject: chatInjected } },
  }, SidebarChatTab)), 'ui-subagent: Sidebar chat body')
  ctx.effect(() => ctx.slots.inject('sidebar.chat.conversation', () => ctx.slots.register({
    name: 'sidebar.chat.conversation',
  }, ConversationSlotPanel)), 'ui-subagent: Sidebar Conversation')
  // Headless profiles can instantiate client registrations without a document.
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const drags = trackSessionDrags(document, () => ctx.sidebarRight.mounted.getSnapshot())
    const injected: SessionDropZoneInjected = {
      hooks: { sessionDrag: drags.source },
      openAside: (sessionId, paneId) => {
        // The on-screen Session can leave between dragstart and drop.
        if (ctx.sidebarRight.mounted.getSnapshot() === undefined) return
        ctx.sidebarRight.openResource(sessionChatAddress(sessionId), paneId === undefined
          ? { kind: 'subagentchat', destination: 'sidebar' }
          : { kind: 'subagentchat', paneId })
      },
    }
    const disposeZone = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'subagent.session-drop', locale: NS, inject: () => injected,
    }, SessionDropZone))
    return () => {
      disposeZone()
      drags.dispose()
    }
  }, 'ui-subagent: Session drop target')
}
