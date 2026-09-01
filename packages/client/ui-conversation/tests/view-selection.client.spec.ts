import { describe, expect, it } from 'vitest'
import { resolveActiveView } from '../src/client/view-selection.ts'
import type { ViewTab } from '../src/client/contract/views.ts'

describe('resolveActiveView', () => {
  it('resolves the preferred registered View and Chat fallback', () => {
    const tabs: readonly ViewTab[] = [
      { id: 'chat', label: 'Chat' },
      { id: 'custom', label: 'Custom' },
    ]

    expect(resolveActiveView(tabs, 'custom')?.id).toBe('custom')
    expect(resolveActiveView(tabs, 'removed')?.id).toBe('chat')
    expect(resolveActiveView(tabs, null)?.id).toBe('chat')
  })

  it('does not choose an arbitrary registered View', () => {
    expect(resolveActiveView([{ id: 'custom', label: 'Custom' }], null)).toBeUndefined()
  })
})
