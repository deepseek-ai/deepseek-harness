// @vitest-environment jsdom
/** The outside-pointer dismissal primitive as observable popover behavior. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives/client'

afterEach(cleanup)

function Popover({ portaled }: { portaled: boolean }) {
  const [open, setOpen] = useState(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(rootRef, open, setOpen, portaled ? panelRef : undefined)
  return (
    <div ref={rootRef} data-testid="root">
      <button type="button">trigger</button>
      {open && !portaled && <div data-testid="surface">surface</div>}
      {open && portaled && createPortal(<div ref={panelRef} data-testid="surface">surface</div>, document.body)}
    </div>
  )
}

describe('useDismissOnOutsidePointer', () => {
  it('closes on an outside pointerdown but not on one inside the root', () => {
    const view = render(<Popover portaled={false} />)
    fireEvent.pointerDown(view.getByTestId('root'))
    expect(view.queryByTestId('surface')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.queryByTestId('surface')).toBeNull()
  })

  it('counts the portaled surface as inside while still closing outside it', () => {
    const view = render(<Popover portaled />)
    fireEvent.pointerDown(view.getByTestId('surface'))
    expect(view.queryByTestId('surface')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.queryByTestId('surface')).toBeNull()
  })
})
