/**
 * Type compatibility commitment to external TypeScript consumers, `/client` spelling: a plugin imports from the
 * `/client` subpath only and augments the `/client` subpath only.
 */
import {
  resolveSlotLabel,
  type GlobalStandardProps,
  type OwnerOf,
  type PropsRenderSlots,
  type SlotMap,
} from '@deepseek-ai/dsh-client-ui-slots/client'
import type { Equal, Expect } from './assert.ts'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'consumer.client': { kind: 'single'; scope: 'root'; owner: { readonly count: number } }
  }
  interface GlobalStandardProps {
    clientSeat: () => number
  }
}

export type SlotKeys = Expect<Equal<keyof SlotMap, 'consumer.client'>>
export type SeatKeys = Expect<Equal<keyof GlobalStandardProps, 'clientSeat'>>
export type Owner = Expect<Equal<OwnerOf<'consumer.client'>, { readonly count: number }>>

declare const renderSlot: PropsRenderSlots<keyof SlotMap & string>['renderSlot']
renderSlot('consumer.client', { count: 1 })
// @ts-expect-error -- the merged SlotMap declares no such slot
renderSlot('consumer.absent', { count: 0 })

export const label: string | undefined = resolveSlotLabel(() => 'client')
