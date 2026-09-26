import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '../src/index.ts'

const header = { type: 'session', version: 3, id: 'parent', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const policy = { recovery: 'strict', validation: 'current' } as const
const child = (id: string) => ({ childId: id, childCreatedAt: 2, descriptorCount: 1,
  descriptor: { version: 3, provider: 'spawn', mode: 'one-shot' } })

describe('parent-specific catalog assembly', () => {
  it('requires explicit children for historical bodies while retaining header and native V4 reads', () => {
    expect(sessionFormatCatalog.readHeader(header).status).toBe('migration-required')
    expect(() => sessionFormatCatalog.createRestore(header, policy)).toThrow('explicit historical child facts')
    expect(createSessionFormatCatalogWithChildren([]).createRestore(header, policy).finish().events).toEqual([])
    expect(sessionFormatCatalog.createRestore({ ...header, version: 4 }, policy).finish().events).toEqual([])
  })

  it('isolates interleaved restores and child evidence across parent catalogs', () => {
    const left = createSessionFormatCatalogWithChildren([child('left-child')])
    const first = left.createRestore(header, policy)
    const second = createSessionFormatCatalogWithChildren([child('right-child')])
      .createRestore({ ...header, id: 'other-parent' }, policy)
    const repeated = left.createRestore(header, policy)
    const row = { type: 'feedback/record', seq: 0, time: 5, data: { text: 'retained' } }
    first.decodeRow(row)
    second.decodeRow(row)
    repeated.decodeRow(row)
    const right = second.finish()
    const result = first.finish()
    expect(result.events).toEqual([row, { type: 'subagent/catalog', seq: 1, time: 5,
      data: { version: 0, childId: 'left-child', childCreatedAt: 2, mode: 'one-shot' } }])
    expect(right.events[1]?.data).toMatchObject({ childId: 'right-child' })
    expect(repeated.finish()).toEqual(result)
    const physical = sessionFormatCatalog.encodeCurrentHeader(result.header, result.inheritedEventCount)
    const reopened = sessionFormatCatalog.createRestore(physical, policy)
    for (const event of result.events) reopened.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
    expect(reopened.finish()).toEqual(result)
  })
})
