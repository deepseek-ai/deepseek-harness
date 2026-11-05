// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelRow } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('PanelRow', () => {
  it('renders a static fact with a decorative icon and no button', () => {
    const view = render(<PanelRow icon={<svg data-testid="glyph" />}>deepseek-harness</PanelRow>)
    expect(screen.getByText('deepseek-harness')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTestId('glyph').parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('[data-panel-row]')?.children).toHaveLength(1)
  })

  it('makes the icon and content one button while the trailing control stays outside it', () => {
    const onActivate = vi.fn()
    const onTrailing = vi.fn()
    render(
      <PanelRow icon={<svg />} onActivate={onActivate} trailing={<button type="button" onClick={onTrailing}>More</button>}>
        Local changes
      </PanelRow>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Local changes' }))
    expect(onActivate).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(onTrailing).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('names the button with the action label', () => {
    const onActivate = vi.fn()
    render(<PanelRow icon={<svg />} onActivate={onActivate} actionLabel="View the changes: 2 files">Local changes</PanelRow>)
    fireEvent.click(screen.getByRole('button', { name: 'View the changes: 2 files' }))
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('forwards attributes such as context-menu handlers to the outer element', () => {
    const onContextMenu = vi.fn()
    const view = render(<PanelRow icon={<svg />} className="placed" onContextMenu={onContextMenu} tabIndex={0}>Row</PanelRow>)
    const row = view.container.querySelector('[data-panel-row]') as HTMLElement
    expect(row.className).toContain('placed')
    expect(row.tabIndex).toBe(0)
    fireEvent.contextMenu(row)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })
})
