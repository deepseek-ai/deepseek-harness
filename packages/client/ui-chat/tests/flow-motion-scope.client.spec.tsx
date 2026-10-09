// @vitest-environment jsdom
/** Fold coordination belongs to its viewport; ordinary searchable hiding stays immediate. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'
import { useSearchableHidden } from '../src/client/chat/searchable-hidden.ts'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { cleanup(); vi.useRealTimers() })

function viewport() {
  const list = document.createElement('div')
  const column = document.createElement('div')
  const row = document.createElement('div')
  const spacer = document.createElement('div')
  spacer.dataset.chatTurnSpacer = ''
  Object.defineProperty(row, 'offsetHeight', { value: 80 })
  column.append(row)
  list.append(column, spacer)
  document.body.append(list)
  const owner = new ChatViewport()
  owner.attach(list, column)
  return { list, row, spacer, owner, dispose: () => { owner.detach(); list.remove() } }
}

it('isolates fold anchoring and reservation between viewports', async () => {
  const first = viewport()
  const second = viewport()
  try {
    first.owner.motion.collapse(first.row, () => { first.row.hidden = true })
    await Promise.resolve()
    expect(first.list.style.overflowAnchor).toBe('none')
    expect(first.spacer.style.height).toBe('80px')
    expect(second.list.style.overflowAnchor).toBe('')
    expect(second.spacer.style.height).toBe('')
  } finally {
    first.dispose()
    second.dispose()
  }
  expect(vi.getTimerCount()).toBe(0)
})

function Searchable({ hidden }: { hidden: boolean }) {
  const ref = useSearchableHidden(hidden, () => {})
  return <div ref={ref} data-testid="row">Details</div>
}

it('keeps ordinary searchable hiding immediate inside a motion-enabled parent', () => {
  const view = render(<div data-chat-motion=""><Searchable hidden={false} /></div>)
  const row = view.getByTestId('row')
  Object.defineProperty(row, 'offsetHeight', { value: 80 })
  view.rerender(<div data-chat-motion=""><Searchable hidden /></div>)
  expect(row.getAttribute('hidden')).toBe('until-found')
  expect(row.style.transition).toBe('')
  act(() => { vi.runAllTimers() })
})
