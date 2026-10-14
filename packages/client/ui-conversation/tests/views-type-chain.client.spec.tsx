// Target-neutral View-ring type chain and runtime ledger projection.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConvViewProps } from '../src/client/contract/slots.ts'

describe('view-ring type negatives (compile-time; body never runs)', () => {
  it('holds the negative samples as expect-error sites', () => {
    const negatives = (slots: SlotRegistry) => {
      // 1. List-kind registration requires the id shape field.
      // @ts-expect-error missing `id` on a list-slot registration
      slots.register({ name: 'conversation.view', order: 1 }, (_p: ConvViewProps) => null)
      // 2. A keyed-kind shape field is rejected on the list slot.
      slots.register(
        // @ts-expect-error `key` belongs to keyed slots, not the list ring
        { name: 'conversation.view', id: 'x', key: 'k' },
        (_p: ConvViewProps) => null)
      // 3. Component props must stay within the composed contract: an
      //    undeclared member cannot be required. The call stays on one line so
      //    both compilers anchor the overload failure inside the directive.
      // @ts-expect-error component demands a prop no share supplies
      slots.register({ name: 'conversation.view', id: 'y' }, (_p: ConvViewProps & { phantom: number }) => null)
      // 4. Views receive no renderSlot — the ring's entries declare no children.
      const renderless = (props: ConvViewProps): ReactNode => {
        // @ts-expect-error views receive no renderSlot — no sub-slot delegation
        void props.renderSlot
        return null
      }
      void renderless
      return null as ReactNode
    }
    expect(negatives).toBeTypeOf('function')
  })
})

describe('view-ring runtime dual (real ledger)', () => {
  function bench() {
    const ctx = new Context()
    const slots = new SlotRegistry(ctx)
    // The conversation entry's role: declare the ring (declaring is claiming).
    slots.register({
      name: 'root',
      children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    }, (_p: { renderSlot?: unknown }) => null)
    return { slots }
  }

  it('registers, orders, projects tabs, and disposes through the slot ledger', () => {
    const { slots } = bench()
    const offLate = slots.register(
      { name: 'conversation.view', id: 'z-late', order: 20, label: '晚' }, () => null)
    const offEarly = slots.register(
      { name: 'conversation.view', id: 'early', order: 0, label: '早' }, () => null)
    // Order-sorted ledger, label fallback for a labelless rider.
    const offBare = slots.register(
      { name: 'conversation.view', id: 'bare', order: 10 }, () => null)
    const tabs = slots.entries('conversation.view')
      .map(e => ({ id: e.options.id, label: e.options.label ?? e.options.id }))
    expect(tabs).toEqual([
      { id: 'early', label: '早' },
      { id: 'bare', label: 'bare' },
      { id: 'z-late', label: '晚' },
    ])
    // Duplicate ids fail loud at load (the ring's uniqueness contract).
    expect(() => slots.register({ name: 'conversation.view', id: 'early' }, () => null))
      .toThrow(/already has an entry with id "early"/)
    offEarly()
    expect(slots.entries('conversation.view').map(e => e.options.id)).toEqual(['bare', 'z-late'])
    offBare()
    offLate()
    expect(slots.entries('conversation.view')).toHaveLength(0)
  })
})
