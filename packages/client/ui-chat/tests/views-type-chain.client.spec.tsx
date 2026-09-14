import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'

describe('Chat View type chain', () => {
  it('keeps Chat injection and store props out of the target-neutral base', () => {
    const negatives = (
      base: ConvViewProps,
      chat: ChatViewSlotProps,
    ): ReactNode => {
      // @ts-expect-error openFile belongs to the Chat inject face.
      void base.openFile
      // @ts-expect-error openFile accepts a path.
      void chat.openFile({ turnSeq: 1, callId: 'c' })
      return null
    }
    expect(negatives).toBeTypeOf('function')
  })
})
