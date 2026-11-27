// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { InspectButton } from '../src/client/InspectButton.tsx'

afterEach(cleanup)

describe('InspectButton', () => {
  it('renders a labelled pill that runs its action', () => {
    const onClick = vi.fn()
    const view = render(<InspectButton label="Inspect call" onClick={onClick} />)
    const button = view.getByRole('button', { name: 'Inspect call' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.querySelector('svg')).not.toBeNull()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('takes a placement class from its owning row', () => {
    const view = render(<InspectButton label="Inspect" onClick={() => {}} className="pinned" />)
    expect(view.getByRole('button').className).toContain('pinned')
  })
})
