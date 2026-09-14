/** assertPlan: provide keys must name roster rows. */
import { describe, expect, it } from 'vitest'
import { assertPlan } from '../src/assembly/roster.ts'
import { ClientRoster } from '../src/assembly/roster.ts'

const roster = ClientRoster.of([
  { name: 'a', inject: [], immediately: false },
  { name: 'b', inject: [], immediately: false },
])
const plugin = { apply: () => {} }

describe('assertPlan', () => {
  it('accepts a bare roster and provided roster rows', () => {
    expect(() => { assertPlan({ roster }) }).not.toThrow()
    expect(() => { assertPlan({ roster, provide: { a: plugin, b: plugin } }) }).not.toThrow()
  })

  it('rejects provide keys outside the roster and lists the roster', () => {
    expect(() => { assertPlan({ roster, provide: { a: plugin, zz: plugin, yy: plugin } }) })
      .toThrow('provide names rows outside the roster: zz, yy; roster: a, b')
  })
})
