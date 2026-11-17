/** The side tab: retained child reference, embedded Chat content, live title and the creation notice. */
import { IconCompareSplitOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidechatNotice } from './control.ts'
import { parseSidechatAddress } from './resource.ts'
import type { NS } from './locales.ts'
import css from './views.module.css'

/** Root overlay inputs keep creation feedback alive when a conversation unmounts. */
export interface SidechatNoticeInjected {
  readonly hooks: { readonly notice: ObservableSnapshot<SidechatNotice | null> }
  readonly dismiss: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Replace the embedded child Conversation; receives its Session scope and no owner data. Absence leaves the tab body empty. */
    'sidechat.conversation': { kind: 'single'; scope: 'session' }
  }
}

/** Bind a retained child reference around the shared Conversation, with loading and failure feedback. */
export function SidechatTab({ useResource, useTabInfo, SessionProvider, renderSlot, t }:
  PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'sidechat.conversation'> & PropsLocale<typeof NS>) {
  const { tab } = useTabInfo()
  const resource = useResource<'sidechat'>(tab.contentId)
  return <div className={css.root} data-sidechat="">
    {resource.value === undefined
      ? <p className={css.notice} role={resource.status === 'failed' ? 'alert' : 'status'}>{t(resource.status === 'failed' ? 'openFailed' : 'loading')}</p>
      : <SessionProvider session={resource.value}>{renderSlot('sidechat.conversation', {})}</SessionProvider>}
  </div>
}

/** Fixed embedded Chat selection. */
function SidechatChatView({ renderSlot }: ConversationViewsProps) {
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Render the shared Conversation content, Chat view and composer, with the child's Session scope. */
export function SidechatConversation({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot,
}: PropsRuntime<'sidechat.conversation'> & PropsRenderFactories) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }, {
    slots: { views: SidechatChatView },
  })
}

/** Live child title with the side glyph in docked and floating headers; the stored title covers an unlisted child. */
export function SidechatTitle({ useTabInfo, useSessions }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const { tab } = useTabInfo()
  const id = parseSidechatAddress(tab.contentId)
  const title = useSessions(value => id === undefined ? tab.title : value.byId[id]?.title ?? tab.title)
  return <><IconCompareSplitOutlineRegular size={16} className={css.titleIcon} />{title}</>
}

/** Show the last creation failure as a root Toast. */
export function SidechatToast({ useNotice, dismiss, t }: PropsRuntime<'shell.overlay'> & InjectFace<SidechatNoticeInjected> & PropsLocale<typeof NS>) {
  const notice = useNotice(value => value)
  return notice === null ? null : <Toast key={notice.serial} text={t(notice.key)} onDone={dismiss} />
}
