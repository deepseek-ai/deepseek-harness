/**
 * Type compatibility commitment to external TypeScript consumers, package-root spelling: a plugin written before the
 * `/client` subpath imports from the package root only and augments the package root only.
 */
import {
  resolveSlotLabel,
  type GlobalStandardProps,
  type OwnerOf,
  type PropsRenderSlots,
  type SlotMap,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { Equal, Expect } from './assert.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'consumer.root': { kind: 'single'; scope: 'root'; owner: { readonly label: string } }
  }
  interface GlobalStandardProps {
    rootSeat: () => string
  }
}

export type SlotKeys = Expect<Equal<keyof SlotMap, 'consumer.root'>>
export type SeatKeys = Expect<Equal<keyof GlobalStandardProps, 'rootSeat'>>
export type Owner = Expect<Equal<OwnerOf<'consumer.root'>, { readonly label: string }>>

declare const renderSlot: PropsRenderSlots<keyof SlotMap & string>['renderSlot']
renderSlot('consumer.root', { label: 'root' })
// @ts-expect-error -- the merged SlotMap declares no such slot
renderSlot('consumer.absent', { label: 'absent' })

export const label: string | undefined = resolveSlotLabel(() => 'root')
