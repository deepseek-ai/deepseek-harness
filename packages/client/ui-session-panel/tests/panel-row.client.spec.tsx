// @vitest-environment jsdom
/** The Session panel row the `conversation.session.panel.row` Factory renders. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelRow } from '../src/client/PanelRow.tsx'

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

  it('places row actions after the trailing area and marks only rows with an action or row actions as interactive', () => {
    const view = render(
      <PanelRow icon={<svg />} trailing={<span>value</span>} menu={<button type="button">More</button>}>Project</PanelRow>,
    )
    const row = view.container.querySelector('[data-panel-row]') as HTMLElement
    expect([...row.children].map(child => child.textContent)).toEqual(['Project', 'value', 'More'])
    const interactive = row.className
    cleanup()
    const plain = render(<PanelRow icon={<svg />} trailing={<span>value</span>}>Project</PanelRow>)
    const staticRow = plain.container.querySelector('[data-panel-row]') as HTMLElement
    expect(staticRow.children).toHaveLength(2)
    expect(staticRow.className).not.toBe(interactive)
  })

  it('puts its attributes, such as context-menu handlers and markers, and its class on the row element', () => {
    const onContextMenu = vi.fn()
    const view = render(
      <PanelRow icon={<svg />} className="placed" attributes={{ onContextMenu, tabIndex: 0, 'data-marker': 'on' }}>Row</PanelRow>,
    )
    const row = view.container.querySelector('[data-panel-row]') as HTMLElement
    expect(row.className).toContain('placed')
    expect(row.tabIndex).toBe(0)
    expect(row.getAttribute('data-marker')).toBe('on')
    fireEvent.contextMenu(row)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it('leaves props outside its own, such as a Factory occurrence adds, off the row element', () => {
    const extra = { renderFactorySlot: vi.fn(), useFactorySlot: vi.fn(), useWorkspaces: vi.fn() }
    const view = render(<PanelRow {...{ icon: <svg />, children: 'Row', ...extra }} />)
    const row = view.container.querySelector('[data-panel-row]') as HTMLElement
    expect(row.getAttributeNames().sort()).toEqual(['class', 'data-panel-row'])
  })
})
