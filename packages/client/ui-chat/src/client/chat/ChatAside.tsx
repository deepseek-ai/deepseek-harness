/** The Chat View's aside layer: one Session-level occupant beside the transcript, which the layer's stylesheet tells the end gutter. */
import { memo } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ChatView.module.css'

/**
 * Render the aside layer with its occupant. The Chat View's `renderSlot` is
 * stable per registration, so the layer renders once and transcript updates
 * do not re-render it; its geometry is CSS only.
 * @param props - the Chat View's slot renderer.
 * @returns the zero-height aside layer.
 */
export const ChatAside = memo(function ChatAside({ renderSlot }: Pick<PropsRenderSlots<'conversation.chat.aside'>, 'renderSlot'>) {
  return <div className={css.asideSlot} data-chat-aside="">{renderSlot('conversation.chat.aside', {})}</div>
})
