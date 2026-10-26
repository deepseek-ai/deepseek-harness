// @vitest-environment jsdom
/** Native row previews keep cloned controls inert and release their DOM. */
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRowDragPreview } from '../src/useRowDragPreview.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Row({ handle }: { handle: boolean }) {
  const preview = useRowDragPreview('surface')
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

function fixture(handle: boolean) {
  const view = render(<Row handle={handle} />)
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

  it('removes a rejected custom preview while allowing native drag cleanup', () => {
    const { source, dataTransfer, start } = fixture(true)
    dataTransfer.setDragImage.mockImplementation(() => { throw new DOMException('Unavailable') })
    const image = start()
    expect(image.isConnected).toBe(false)
    fireEvent.dragEnd(source)
  })
})
