/** The client reader for share access and endpoint offers: only a complete record becomes presentable. */

import { describe, expect, it } from 'vitest'
import { readAccess, readCapabilityGroups } from '../src/client/share-types.ts'

describe('confirmed share access', () => {
  it('summarizes the mode and both subject counts', () => {
    expect(readAccess({
      mode: 'selected',
      selected: [{ subjectId: 'a' }, { subjectId: 'b' }],
      deploymentAllowedSubjectIds: ['c'],
    })).toEqual({ mode: 'selected', selectedCount: 2, deploymentCount: 1 })
    expect(readAccess({ mode: 'open', selected: [], deploymentAllowedSubjectIds: [] }))
      .toEqual({ mode: 'open', selectedCount: 0, deploymentCount: 0 })
  })

  it('reads nothing as confirmed from a value that is not an access record', () => {
    for (const refused of [undefined, null, 'selected', 3]) expect(readAccess(refused)).toBeUndefined()
    // A legacy record states no mode; a malformed one states a mode this build cannot confirm.
    expect(readAccess({})).toBeUndefined()
    expect(readAccess({ mode: 'everyone', selected: [], deploymentAllowedSubjectIds: [] })).toBeUndefined()
    expect(readAccess({ mode: 'open', selected: [], deploymentAllowedSubjectIds: 'all' })).toBeUndefined()
  })
})

describe('viewer endpoint offers', () => {
  it('reads one plugin entry with both endpoint lists', () => {
    expect(readCapabilityGroups([{ plugin: 'ui-chat', readable: ['session/list'], writable: [] }]))
      .toEqual([{ plugin: 'ui-chat', readable: ['session/list'], writable: [] }])
  })

  it('leaves out every entry this build cannot present, keeping the readable ones in order', () => {
    expect(readCapabilityGroups([
      // A value that names no plugin, and one whose plugin name is empty.
      { readable: ['session/list'], writable: [] },
      { plugin: '', readable: [], writable: [] },
      // One missing list, and one list holding a non-string entry.
      { plugin: 'no-writable', readable: ['session/list'] },
      { plugin: 'bad-entry', readable: ['session/list', 3], writable: [] },
      { plugin: 'ui-chat', readable: [], writable: ['session/prompt'] },
    ])).toEqual([{ plugin: 'ui-chat', readable: [], writable: ['session/prompt'] }])
  })

  it('reads no offer at all from a host that reports none', () => {
    for (const empty of [undefined, null, 'ui-chat', 3]) expect(readCapabilityGroups(empty)).toEqual([])
    // Null entries in an otherwise readable array name no group either.
    expect(readCapabilityGroups([null, 'ui-chat'])).toEqual([])
  })
})
