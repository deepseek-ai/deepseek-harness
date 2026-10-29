// @vitest-environment jsdom
import { useCallback, useState, type ComponentProps } from 'react'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { QuoteSelectionAction } from '../src/client/QuoteSelection.tsx'

afterEach(cleanup)

type Props = ComponentProps<typeof QuoteSelectionAction>
function props(enabled = true, subagent: SessionSnapshot['subagent'] = null) {
  const inputActions = { insertQuote: vi.fn(() => true) }
  const value = {
    trigger: 'selection',
    dismiss: vi.fn(), readText: vi.fn((): string | null => 'Hello world'), clearSelection: vi.fn(),
    inputActions, useSession: selector => selector({ sessionId: SessionId('quote-selection'), pendingSubmissions: [], running: false, removed: !enabled, openState: 'open', openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent, lastAgentError: null, promptAttempted: true, awaitingFirstTurn: false }),
    t: () => 'Quote text',
  } as Props
  return { value, inputActions }
}

describe('quote action consumer', () => {
  it('inserts DOM text and clears the browser selection only after success', () => {
    const fixture = props()
    const view = render(<QuoteSelectionAction {...fixture.value} />)
    const button = view.getByRole('button', { name: 'Quote text' })
    fireEvent.pointerDown(button)
    fixture.inputActions.insertQuote.mockReturnValueOnce(false)
    fireEvent.click(button)
    expect(fixture.value.dismiss).not.toHaveBeenCalled()
    expect(fixture.value.clearSelection).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(fixture.inputActions.insertQuote).toHaveBeenLastCalledWith('Hello world')
    expect(fixture.value.clearSelection).toHaveBeenCalledOnce()
    expect(fixture.value.dismiss).toHaveBeenCalledOnce()
  })

  it('closes an invalidated source without inserting stale text', () => {
    const fixture = props()
    vi.mocked(fixture.value.readText).mockReturnValue(null)
    const view = render(<QuoteSelectionAction {...fixture.value} />)
    fireEvent.click(view.getByRole('button'))
    expect(fixture.inputActions.insertQuote).not.toHaveBeenCalled()
    expect(fixture.value.dismiss).toHaveBeenCalledOnce()
  })

  it('hides the action when its Session is no longer writable', () => {
    const fixture = props(false)
    const view = render(<QuoteSelectionAction {...fixture.value} />)
    expect(view.queryByRole('button')).toBeNull()
    expect(fixture.value.dismiss).toHaveBeenCalledOnce()
  })

  it('responds to changes in a continuable subagent parent availability', () => {
    const child = {
      address: { parentSessionId: SessionId('parent'), childSessionId: SessionId('quote-selection'), mode: 'continuable' as const },
      parentAvailable: true,
    }
    const fixture = props(true, child)
    const view = render(<QuoteSelectionAction {...fixture.value} />)
    expect(view.queryByRole('button')).not.toBeNull()
    view.rerender(<QuoteSelectionAction {...props(true, { ...child, parentAvailable: false }).value} />)
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(<QuoteSelectionAction {...props(true, { ...child, address: { ...child.address, mode: 'one-shot' } }).value} />)
    expect(view.queryByRole('button')).toBeNull()
  })

  it('dismisses the surface when its Session becomes unwritable without reopening it on recovery', () => {
    function Surface({ value }: { value: Props }) {
      const [open, setOpen] = useState(true)
      const dismiss = useCallback(() => { setOpen(false) }, [])
      return open ? <QuoteSelectionAction {...value} dismiss={dismiss} /> : null
    }
    const fixture = props()
    const view = render(<Surface value={fixture.value} />)
    expect(view.queryByRole('button')).not.toBeNull()
    view.rerender(<Surface value={props(false).value} />)
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(<Surface value={fixture.value} />)
    expect(view.queryByRole('button')).toBeNull()
  })

})
