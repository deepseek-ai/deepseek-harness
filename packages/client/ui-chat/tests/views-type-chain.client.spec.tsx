import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatFlowOwnerProps, ChatNodeHookContext, ChatViewSlotProps } from '../src/client/contract/slots.ts'

describe('Chat View type chain', () => {
  it('keeps Chat injection and store props out of the target-neutral base', () => {
    const negatives = (
      base: ConvViewProps,
      chat: ChatViewSlotProps,
      flowOwner: ChatFlowOwnerProps,
      nodeContext: ChatNodeHookContext,
    ): ReactNode => {
      // @ts-expect-error openFile belongs to the Chat inject face.
      void base.openFile
      // @ts-expect-error openFile accepts a path.
      void chat.openFile({ turnSeq: 1, callId: 'c' })
      // @ts-expect-error ChatView renders only its flow child.
      chat.renderSlot('conversation.chat.node', {}, { hookContext: nodeContext })
      // @ts-expect-error Image rendering belongs to the flow.
      chat.renderSlot('conversation.message.images', {})
      // @ts-expect-error Flow owner data cannot override the flow's render authority.
      void flowOwner.renderSlot
      // @ts-expect-error Node renderers receive the bound hook, not the viewport controller.
      void nodeContext.motion
      return null
    }
    expect(negatives).toBeTypeOf('function')
  })
})
