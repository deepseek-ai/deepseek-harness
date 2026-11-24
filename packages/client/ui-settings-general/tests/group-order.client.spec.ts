// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { compareGroupOrder } from '../src/client/group-order.ts'

describe('compareGroupOrder', () => {
  it('orders by declared order and treats an omitted order as zero', () => {
    expect(compareGroupOrder({ options: { order: 20 } }, { options: { order: 10 } })).toBeGreaterThan(0)
    expect(compareGroupOrder({ options: { order: 10 } }, { options: { order: 20 } })).toBeLessThan(0)
    expect(compareGroupOrder({ options: {} }, { options: { order: 10 } })).toBeLessThan(0)
    expect(compareGroupOrder({ options: { order: 10 } }, { options: {} })).toBeGreaterThan(0)
    expect(compareGroupOrder({ options: {} }, { options: {} })).toBe(0)
  })
})
