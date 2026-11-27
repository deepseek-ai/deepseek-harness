// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { ImageLightbox } from '../src/client/ImageLightbox.tsx'
import { Menu } from '../src/client/Menu.tsx'

afterEach(cleanup)

const labels = { dialog: '原图预览', close: '关闭原图预览' }

describe('ImageLightbox', () => {
  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    const outerKey = vi.fn()
    document.body.addEventListener('keydown', outerKey)
    try {
      fireEvent.keyDown(close, { key: 'Escape' })
      expect(outerKey).not.toHaveBeenCalled()
    } finally { document.body.removeEventListener('keydown', outerKey) }
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

it('leaves Escape to an open context menu before closing the image', () => {
  const onClose = vi.fn()
  const view = render(<ImageLightbox src="blob:original" alt="Image" labels={labels} onClose={onClose} />)
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.tabIndex = 0
  document.body.append(menu)
  menu.focus()
  try {
    fireEvent.keyDown(view.getByRole('button'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  } finally { menu.remove() }
  fireEvent.keyDown(view.getByRole('button'), { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})

it('leaves Tab and Escape to the search controls in a portaled image menu', () => {
  const onClose = vi.fn()
  function Preview() {
    const [point, setPoint] = useState<{ x: number; y: number }>()
    return <>
      <ImageLightbox src="blob:original" alt="Image" labels={labels} onClose={onClose}
        contextMenuProps={{ tabIndex: 0, onContextMenu: (event) => {
          event.preventDefault()
          setPoint({ x: event.clientX, y: event.clientY })
        } }} />
      <Menu open={point !== undefined} anchor={null} anchorPoint={point} portal contextual
        search={{ label: 'Search actions', clearLabel: 'Clear search', value: '', onChange: () => {} }}
        items={[{ id: 'copy', label: 'Copy image' }]} onClose={() => { setPoint(undefined) }} />
    </>
  }
  const view = render(<Preview />)
  const image = view.getByRole('img')
  image.focus()
  fireEvent.contextMenu(image)
  const search = view.getByRole('searchbox', { name: 'Search actions' })
  const clear = view.getByRole('button', { name: 'Clear search' })
  expect(document.activeElement).toBe(search)
  expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true)
  clear.focus()
  fireEvent.keyDown(clear, { key: 'Tab' })
  expect(document.activeElement).toBe(view.getByRole('menuitem', { name: 'Copy image' }))
  clear.focus()
  fireEvent.keyDown(clear, { key: 'Escape' })
  expect(view.queryByRole('searchbox')).toBeNull()
  expect(document.activeElement).toBe(image)
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.keyDown(image, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})
