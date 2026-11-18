/** A renamed Session must reach the share's recorded title, and nothing else must change it. */

import { describe, expect, it } from 'vitest'
import { refreshedShareTitle } from '../src/host/share-host.ts'

describe('Liveshare share title refresh', () => {
  it('adopts the Session title the title fold reports', () => {
    expect(refreshedShareTitle('Local loop', 'This is a long-running objective:'))
      .toBe('This is a long-running objective:')
  })

  it('keeps the recorded title when the Session reports the same one or none', () => {
    expect(refreshedShareTitle('Local loop', 'Local loop')).toBeUndefined()
    expect(refreshedShareTitle('Local loop', undefined)).toBeUndefined()
    expect(refreshedShareTitle('Local loop', '')).toBeUndefined()
    expect(refreshedShareTitle('Local loop', 42)).toBeUndefined()
  })
})
