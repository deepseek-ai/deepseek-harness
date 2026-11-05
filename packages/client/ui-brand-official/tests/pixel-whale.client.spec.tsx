// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WHALE_ARTWORK } from '../src/client/home-whale/artwork.ts'
import { PixelWhale } from '../src/client/home-whale/PixelWhale.tsx'
import { attachPixelWhale } from '../src/client/home-whale/renderer.ts'

vi.mock('../src/client/home-whale/renderer.ts', () => ({ attachPixelWhale: vi.fn() }))

const attach = vi.mocked(attachPixelWhale)

function handle() {
  const whale = { play: vi.fn(), dispose: vi.fn() }
  attach.mockReturnValueOnce(whale)
  return whale
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  document.body.replaceChildren()
  attach.mockReset()
})

describe('pixel whale frame layer', () => {
  it('attaches the artwork to a canvas before its content and releases it on unmount', () => {
    const whale = handle()
    const view = render(<PixelWhale hero><p>content</p></PixelWhale>)
    const canvas = view.container.querySelector('canvas')
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')
    expect(canvas?.nextElementSibling?.textContent).toBe('content')
    expect(attach).toHaveBeenCalledExactlyOnceWith(canvas, WHALE_ARTWORK, expect.stringContaining('breach-atlas'))
    view.rerender(<PixelWhale hero><p>updated</p></PixelWhale>)
    expect(attach).toHaveBeenCalledOnce()
    view.unmount()
    expect(whale.dispose).toHaveBeenCalledOnce()
  })

  it('wraps its content without decoration outside the blank home', () => {
    const whale = handle()
    const view = render(<PixelWhale hero><p>content</p></PixelWhale>)
    view.rerender(<PixelWhale hero={false}><p>content</p></PixelWhale>)
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(view.getByText('content')).toBeTruthy()
    expect(whale.dispose).toHaveBeenCalledOnce()
    fireEvent.click(view.getByText('content'))
    expect(whale.play).not.toHaveBeenCalled()
  })

  it('plays only for primary clicks on blank space inside its own frame', () => {
    const whale = handle()
    const overlay = document.createElement('div')
    document.body.append(overlay)
    const view = render(
      <PixelWhale hero>
        <section data-testid="blank">
          <button type="button">control</button>
          <div data-composer-card=""><span>card</span></div>
          {createPortal(<span>overlay</span>, overlay)}
        </section>
      </PixelWhale>,
    )
    fireEvent.click(view.getByText('control'))
    fireEvent.click(view.getByText('card'))
    fireEvent.click(view.getByText('overlay'))
    fireEvent.click(view.getByTestId('blank'), { button: 2 })
    expect(whale.play).not.toHaveBeenCalled()
    fireEvent.click(view.getByTestId('blank'))
    expect(whale.play).toHaveBeenCalledOnce()
  })

  it('does not play when the click ends a text selection made inside its frame', () => {
    const whale = handle()
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.append(outside)
    const view = render(<PixelWhale hero><p data-testid="text">selectable headline</p></PixelWhale>)
    const text = view.getByTestId('text')
    const selection = window.getSelection()!
    selection.selectAllChildren(text)
    fireEvent.click(text)
    expect(whale.play).not.toHaveBeenCalled()
    // A selection left elsewhere in the document does not block playback.
    selection.selectAllChildren(outside)
    fireEvent.click(text)
    expect(whale.play).toHaveBeenCalledOnce()
    selection.removeAllRanges()
    fireEvent.click(text)
    expect(whale.play).toHaveBeenCalledTimes(2)
  })

  it('plays when the document exposes no selection', () => {
    const whale = handle()
    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    const view = render(<PixelWhale hero><p data-testid="text">headline</p></PixelWhale>)
    fireEvent.click(view.getByTestId('text'))
    expect(whale.play).toHaveBeenCalledOnce()
  })
})
