/**
 * Type compatibility commitment to external TypeScript consumers, both spellings in one file: the package-root
 * augmentation comes first, then the `/client` augmentation, and both import specifiers read one merged interface.
 */
import { resolveSlotLabel, type GlobalStandardProps as RootSeats, type SlotMap as RootSlots } from '@deepseek-ai/dsh-client-ui-slots'
import {
  type GlobalStandardProps as ClientSeats,
  type OwnerOf,
  type PropsRenderSlots,
  type SlotMap as ClientSlots,
} from '@deepseek-ai/dsh-client-ui-slots/client'
import type { Equal, Expect } from './assert.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'consumer.root': { kind: 'single'; scope: 'root'; owner: { readonly label: string } }
  }
  interface GlobalStandardProps {
    rootSeat: () => string
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'consumer.client': { kind: 'single'; scope: 'root'; owner: { readonly count: number } }
  }
  interface GlobalStandardProps {
    clientSeat: () => number
  }
}

export type RootSlotKeys = Expect<Equal<keyof RootSlots, 'consumer.root' | 'consumer.client'>>
export type ClientSlotKeys = Expect<Equal<keyof ClientSlots, 'consumer.root' | 'consumer.client'>>
export type SameSlotMap = Expect<Equal<RootSlots, ClientSlots>>
export type RootSeatKeys = Expect<Equal<keyof RootSeats, 'rootSeat' | 'clientSeat'>>
export type SameSeats = Expect<Equal<RootSeats, ClientSeats>>
export type RootOwner = Expect<Equal<OwnerOf<'consumer.root'>, { readonly label: string }>>
export type ClientOwner = Expect<Equal<OwnerOf<'consumer.client'>, { readonly count: number }>>

declare const renderSlot: PropsRenderSlots<keyof ClientSlots & string>['renderSlot']
renderSlot('consumer.root', { label: 'root' })
renderSlot('consumer.client', { count: 1 })
// @ts-expect-error -- the merged SlotMap declares no such slot
renderSlot('consumer.absent', { count: 0 })

export const label: string | undefined = resolveSlotLabel(() => 'mixed')
