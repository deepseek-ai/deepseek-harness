// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('Switch', () => {
  it('exposes its state and its caller-owned name to assistive technology', () => {
    render(<Switch checked label="Subagent model selection" onChange={() => {}} />)
    const control = screen.getByRole('switch', { name: 'Subagent model selection' })
    expect(control.getAttribute('aria-checked')).toBe('true')
  })

  it('reports the state the click asks for, not the state it has', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Switch checked={false} label="Toggle" onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)

    onChange.mockClear()
    rerender(<Switch checked label="Toggle" onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('stays silent while disabled', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} disabled label="Toggle" onChange={onChange} />)
    const control = screen.getByRole('switch')
    expect((control as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(control)
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps focus while pending and refuses repeated activation (checked: %s)', (checked) => {
    const onChange = vi.fn()
    const { rerender } = render(<Switch checked={checked} label="Toggle" onChange={onChange} />)
    const control = screen.getByRole('switch') as HTMLButtonElement
    control.focus()
    rerender(<Switch checked={checked} pending label="Toggle" onChange={onChange} />)
    expect(control.disabled).toBe(false)
    expect(control.getAttribute('aria-disabled')).toBe('true')
    expect(control.getAttribute('aria-busy')).toBe('true')
    expect(control.getAttribute('aria-checked')).toBe(String(checked))
    expect(document.activeElement).toBe(control)
    fireEvent.click(control)
    fireEvent.click(control)
    expect(onChange).not.toHaveBeenCalled()
    rerender(<Switch checked={checked} label="Toggle" onChange={onChange} />)
    expect(control.getAttribute('aria-disabled')).toBeNull()
    expect(control.getAttribute('aria-busy')).toBeNull()
    expect(document.activeElement).toBe(control)
    fireEvent.click(control)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(!checked)
  })

  it('keeps a locked switch natively disabled while pending', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} pending disabled label="Toggle" onChange={onChange} />)
    const control = screen.getByRole('switch') as HTMLButtonElement
    expect(control.disabled).toBe(true)
    expect(control.getAttribute('aria-disabled')).toBe('true')
    expect(control.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(control)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('carries a lock reason as the hover title when the owner names one', () => {
    render(<Switch checked={false} disabled label="Toggle" title="Managed by policy" onChange={() => {}} />)
    expect(screen.getByRole('switch').getAttribute('title')).toBe('Managed by policy')
  })

  it('never submits a surrounding form', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => { event.preventDefault() })
    render(<form onSubmit={onSubmit}><Switch checked={false} label="Toggle" onChange={() => {}} /></form>)
    fireEvent.click(screen.getByRole('switch'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps a caller class alongside its own so a render site can place it', () => {
    render(<Switch checked={false} className="placed" label="Toggle" onChange={() => {}} />)
    const control = screen.getByRole('switch')
    expect(control.classList.contains('placed')).toBe(true)
    expect(control.classList.length).toBeGreaterThan(1)
  })
})
