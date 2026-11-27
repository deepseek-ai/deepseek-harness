/**
 * Type compatibility commitment to external TypeScript consumers, two-file scenario: reads the interfaces that
 * [`root-augmentation.ts`](root-augmentation.ts) and [`client-augmentation.ts`](client-augmentation.ts) augment. The
 * check compiles the two augmentation files in both orders.
 */
import type { GlobalStandardProps as RootSeats, SlotMap as RootSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GlobalStandardProps as ClientSeats,
  OwnerOf,
  PropsRenderSlots,
  SlotMap as ClientSlots,
} from '@deepseek-ai/dsh-client-ui-slots/client'
import type { Equal, Expect } from './assert.ts'

export type RootSlotKeys = Expect<Equal<keyof RootSlots, 'consumer.root' | 'consumer.client'>>
export type ClientSlotKeys = Expect<Equal<keyof ClientSlots, 'consumer.root' | 'consumer.client'>>
export type SameSlotMap = Expect<Equal<RootSlots, ClientSlots>>
export type ClientSeatKeys = Expect<Equal<keyof ClientSeats, 'rootSeat' | 'clientSeat'>>
export type SameSeats = Expect<Equal<RootSeats, ClientSeats>>
export type RootOwner = Expect<Equal<OwnerOf<'consumer.root'>, { readonly label: string }>>

declare const renderSlot: PropsRenderSlots<keyof RootSlots & string>['renderSlot']
renderSlot('consumer.client', { count: 1 })
// @ts-expect-error -- the merged SlotMap declares no such slot
renderSlot('consumer.absent', { count: 0 })
