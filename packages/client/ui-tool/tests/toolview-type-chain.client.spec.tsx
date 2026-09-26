// The Tool-owned keyed-slot type chain: registration shape and composed
// atomic-view props. Generic slot-system duals live in ui-slots tests.
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ToolCallViewProps } from '../src/client/contract/slots.ts'

describe('toolview type negatives (compile-time; body never runs)', () => {
  it('holds the negative samples as expect-error sites', () => {
    const negatives = (slots: SlotRegistry) => {
      // Keyed registration requires the key shape field.
      // @ts-expect-error missing `key` on a keyed-slot registration
      slots.register({ name: 'tool.call.toolview' }, (_p: ToolCallViewProps) => null)
      slots.register(
        // @ts-expect-error `id`/`order` belong to list slots, not the keyed hole
        { name: 'tool.call.toolview', key: 'k', order: 1 },
        (_p: ToolCallViewProps) => null)
      const overreaching = (props: ToolCallViewProps): ReactNode => {
        // @ts-expect-error loadOlder belongs to the conversation host, not an atomic Tool view
        void props.loadOlder
        return null
      }
      void overreaching
      const drifted = (props: ToolCallViewProps): ReactNode => {
        if (props.phase === 'preparing') {
          // @ts-expect-error preparation has no complete arguments
          void props.block.argsRaw
          // @ts-expect-error preparation has no result content
          void props.block.content
        }
        // @ts-expect-error the Tool call union has no pre-parsed args member
        void props.block.argsParsed
        return null
      }
      void drifted
      return null as ReactNode
    }
    expect(negatives).toBeTypeOf('function')
  })
})
