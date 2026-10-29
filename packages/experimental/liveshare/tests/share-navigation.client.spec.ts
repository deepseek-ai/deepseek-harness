/** The in-memory handoff from the global share list to one Session's header action. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  forgetManagedShare, openManagedSession, rememberManagedShare, setManagedShareOpener, takeManagedShare,
} from '../src/client/share-navigation.ts'

afterEach(() => { forgetManagedShare(); setManagedShareOpener(undefined) })

describe('managed share handoff', () => {
  it('consumes one matching request and drops the rest', () => {
    rememberManagedShare('session-b')
    expect(takeManagedShare('session-a')).toBe(false)
    expect(takeManagedShare('session-b')).toBe(true)
    expect(takeManagedShare('session-b')).toBe(false)
  })

  it('forgets a request when navigation cannot complete', () => {
    rememberManagedShare('session-a')
    forgetManagedShare()
    expect(takeManagedShare('session-a')).toBe(false)
  })

  it('opens the bound workspace Session when one exists', () => {
    const open = vi.fn()
    openManagedSession('session-a')
    setManagedShareOpener(open)
    openManagedSession('session-a')
    expect(open).toHaveBeenCalledWith('session-a')
  })
})
