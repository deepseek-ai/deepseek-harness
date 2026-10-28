// @vitest-environment jsdom
/** Native row previews keep cloned controls inert and release their DOM. */
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRowDragPreview } from '../src/useRowDragPreview.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Row({ handle, properties }: { handle: boolean; properties?: readonly `--${string}`[] | undefined }) {
  const preview = useRowDragPreview('surface', properties)
  return <div
    data-row-key="row"
    style={{ paddingInlineStart: '32px' }}
    draggable={!handle}
    onDragStart={handle ? undefined : preview.start}
    onDragEnd={preview.clear}
  >
    <button
      draggable={handle}
      onDragStart={handle ? (event) => { preview.start(event, event.currentTarget.parentElement as HTMLElement) } : undefined}
    >Drag</button>
    <input aria-label="Name" defaultValue="Draft" />
  </div>
}

function fixture(handle: boolean, properties?: readonly `--${string}`[]) {
  const view = render(<Row handle={handle} properties={properties} />)
  const button = screen.getByRole('button')
  const row = button.parentElement as HTMLElement
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 10, 200, 40))
  const source = handle ? button : row
  const dataTransfer = { setDragImage: vi.fn<(element: HTMLElement, x: number, y: number) => void>() }
  const start = () => {
    const event = createEvent.dragStart(source, { dataTransfer })
    Object.defineProperties(event, { clientX: { value: 20 }, clientY: { value: 30 } })
    fireEvent(source, event)
    return dataTransfer.setDragImage.mock.calls.at(-1)![0]
  }
  return { ...view, row, source, dataTransfer, start }
}

describe('row drag preview', () => {
  it.each([false, true])('copies the whole row with handle=%s and removes replaced, ended, or unmounted previews', (handle) => {
    const { row, source, dataTransfer, start, unmount } = fixture(handle)
    const originalStyle = row.getAttribute('style')
    const first = start()
    expect(dataTransfer.setDragImage).toHaveBeenLastCalledWith(first, 15, 20)
    expect(first.inert).toBe(true)
    expect(first.getAttribute('aria-hidden')).toBe('true')
    expect(first.className).toContain('surface')
    expect(first.style.width).toBe('200px')
    expect(first.style.height).toBe('40px')
    expect(first.style.left).toBe('-200px')
    expect(first.querySelector('[data-row-key]')).toBeNull()
    expect((first.firstElementChild as HTMLElement).style.paddingInlineStart).toBe('32px')
    expect(first.querySelector('input')?.value).toBe('Draft')
    expect([...first.querySelectorAll('button, input')].every(control => (control as HTMLElement).tabIndex === -1)).toBe(true)
    expect(row.getAttribute('style')).toBe(originalStyle)
    const second = start()
    expect(first.isConnected).toBe(false)
    fireEvent.dragEnd(source)
    expect(second.isConnected).toBe(false)
    const third = start()
    unmount()
    expect(third.isConnected).toBe(false)
  })

  it('copies only requested custom properties without enumerating computed styles', () => {
    const { row, start } = fixture(false, ['--row-inset', '--row-label-gap'])
    const original = globalThis.getComputedStyle
    const computed = document.createElement('div').style
    computed.cssText = original(row).cssText
    computed.setProperty('--row-inset', '3px')
    computed.setProperty('--row-label-gap', '6px')
    computed.setProperty('--unrelated-theme-color', 'red')
    const enumerate = vi.spyOn(computed, 'item')
    vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element, pseudo) =>
      element === row ? computed : original(element, pseudo))
    const image = start()
    expect(image.style.getPropertyValue('--row-inset')).toBe('3px')
    expect(image.style.getPropertyValue('--row-label-gap')).toBe('6px')
    expect(image.style.getPropertyValue('--unrelated-theme-color')).toBe('')
    expect(enumerate).not.toHaveBeenCalled()
    expect(row.style.getPropertyValue('--row-inset')).toBe('')
    expect(row.style.getPropertyValue('--row-label-gap')).toBe('')
  })

  it('does not copy custom properties to the wrapper when no list is supplied', () => {
    const { row, start } = fixture(false)
    row.style.setProperty('--unrelated-theme-color', 'red')
    expect(start().style.getPropertyValue('--unrelated-theme-color')).toBe('')
  })

  it.each([false, true])('keeps a preview through rerenders with a stable property list (configured: %s)', (configured) => {
    const properties = configured ? ['--row-inset'] as const : undefined
    const { start, rerender } = fixture(false, properties)
    const image = start()
    rerender(<Row handle={false} properties={properties} />)
    expect(image.isConnected).toBe(true)
    rerender(<Row handle={false} properties={['--row-label-gap']} />)
    expect(image.isConnected).toBe(false)
  })

  it('leaves a requested but undefined custom property unset', () => {
    const { start } = fixture(false, ['--missing'])
    expect(start().style.getPropertyValue('--missing')).toBe('')
  })

  it('removes a rejected custom preview while allowing native drag cleanup', () => {
    const { source, dataTransfer, start } = fixture(true)
    dataTransfer.setDragImage.mockImplementation(() => { throw new DOMException('Unavailable') })
    const image = start()
    expect(image.isConnected).toBe(false)
    fireEvent.dragEnd(source)
  })
})
