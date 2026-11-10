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

  it('puts a detail line under the content and keeps the trailing area beside both lines', () => {
    const view = render(
      <PanelRow icon={<svg />} detail={<span>gh auth login</span>} trailing={<button type="button">Copy</button>}>Sign in</PanelRow>,
    )
    const row = view.container.querySelector('[data-panel-row]') as HTMLElement
    const lines = screen.getByText('Sign in').parentElement as HTMLElement
    expect([...lines.children].map(line => line.textContent)).toEqual(['Sign in', 'gh auth login'])
    expect([...row.children].map(child => child.textContent)).toEqual(['Sign ingh auth login', 'Copy'])
    const plain = render(<PanelRow icon={<svg />}>Sign in</PanelRow>).container.querySelector('[data-panel-row]') as HTMLElement
    expect(row.className).not.toBe(plain.className)
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
