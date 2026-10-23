// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DraggableImage } from '../src/DraggableImage.tsx'
import type { PreparedFileDrag } from '../src/file-drag-actions.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture(src = '/image.png') {
  const prepared = { start: vi.fn(() => true), release: vi.fn() }
  const actions = { prepare: vi.fn<() => Promise<PreparedFileDrag>>(async () => prepared), reportFailure: vi.fn() }
  const open = vi.fn()
  const view = render(<button onClick={open}><DraggableImage fileDrag={actions} src={src} name="original.png" alt="source" /></button>)
  const image = view.getByRole('img')
  return { prepared, actions, open, view, image }
}

it('prepares only on intent, releases on leave and reprepares for another drag', async () => {
  const f = fixture()
  expect(f.actions.prepare).not.toHaveBeenCalled()
  await act(async () => { fireEvent.pointerEnter(f.image) })
  expect(f.actions.prepare).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.pointerEnter(f.image) })
  expect(f.actions.prepare).toHaveBeenCalledOnce()
  const data = {}
  fireEvent.dragStart(f.image, { dataTransfer: data })
  expect(f.prepared.start).toHaveBeenCalledExactlyOnceWith(data, f.image)
  fireEvent.pointerLeave(f.image)
  expect(f.prepared.release).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.pointerEnter(f.image) })
  expect(f.actions.prepare).toHaveBeenCalledTimes(2)
  fireEvent.dragEnd(f.image)
  expect(f.prepared.release).toHaveBeenCalledTimes(2)
})

it('silently cancels pending preparation and releases a late result after unmount', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<PreparedFileDrag>()
  f.actions.prepare.mockReturnValue(pending.promise)
  fireEvent.dragStart(f.image, { dataTransfer: {} })
  expect(f.actions.reportFailure).not.toHaveBeenCalled()
  f.view.unmount()
  await act(async () => { pending.resolve(f.prepared); await pending.promise })
  expect(f.prepared.release).toHaveBeenCalledOnce()
  expect(f.prepared.start).not.toHaveBeenCalled()
})

it('retains preparation when the pressed pointer leaves a small source before dragstart', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const f = fixture()
  await act(async () => { fireEvent.pointerDown(f.image, { button: 0, buttons: 1 }) })
  fireEvent.pointerLeave(f.image, { buttons: 1 })
  expect(f.prepared.release).not.toHaveBeenCalled()
  fireEvent.dragStart(f.image, { dataTransfer: {} })
  expect(f.prepared.start).toHaveBeenCalledOnce()
  fireEvent.pointerUp(window)
  expect(f.prepared.release).toHaveBeenCalledOnce()
})

it('releases an abandoned preparation when the window loses focus', async () => {
  const f = fixture()
  await act(async () => { fireEvent.pointerEnter(f.image) })
  fireEvent.blur(window)
  expect(f.prepared.release).toHaveBeenCalledOnce()
})

it('keeps preparation after clicking without leaving so the next drag starts immediately', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const f = fixture()
  await act(async () => { fireEvent.pointerEnter(f.image) })
  fireEvent.pointerDown(f.image, { button: 0, buttons: 1 })
  fireEvent.pointerUp(f.image)
  expect(f.prepared.release).not.toHaveBeenCalled()
  fireEvent.pointerDown(f.image, { button: 0, buttons: 1 })
  fireEvent.dragStart(f.image, { dataTransfer: {} })
  expect(f.actions.prepare).toHaveBeenCalledOnce()
  expect(f.prepared.start).toHaveBeenCalledOnce()
})

it('retains a pending local preparation after release inside the image for a later drag', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const f = fixture()
  const pending = Promise.withResolvers<PreparedFileDrag>()
  f.actions.prepare.mockReturnValue(pending.promise)
  f.view.rerender(<DraggableImage fileDrag={f.actions} src="/image.png" name="image.png" resourceAddress="dsh-resource://file/session/s/image.png" alt="source" />)
  const image = f.view.getByRole('img')
  fireEvent.pointerEnter(image)
  expect(f.actions.prepare).not.toHaveBeenCalled()
  fireEvent.pointerDown(image, { button: 0, buttons: 1 })
  expect(fireEvent.dragStart(image, { dataTransfer: {} })).toBe(false)
  fireEvent.pointerUp(image)
  await act(async () => { pending.resolve(f.prepared); await pending.promise })
  expect(f.prepared.release).not.toHaveBeenCalled()
  fireEvent.pointerDown(image, { button: 0, buttons: 1 })
  fireEvent.dragStart(image, { dataTransfer: {} })
  expect(f.prepared.start).toHaveBeenCalledOnce()
})

it('reports a settled preparation failure only on the next drag and retries', async () => {
  const f = fixture()
  f.actions.prepare.mockRejectedValueOnce(new Error('unreadable'))
  await act(async () => { fireEvent.pointerEnter(f.image) })
  expect(f.actions.reportFailure).not.toHaveBeenCalled()
  await act(async () => { expect(fireEvent.dragStart(f.image, { dataTransfer: {} })).toBe(false) })
  expect(f.actions.reportFailure).toHaveBeenCalledOnce()
  expect(f.actions.prepare).toHaveBeenCalledTimes(2)
})

it('keeps unreadable cross-origin image dragging native', async () => {
  const f = fixture('https://other.test/image.png')
  f.actions.prepare.mockRejectedValueOnce(new Error('CORS'))
  await act(async () => { fireEvent.pointerEnter(f.image) })
  expect(fireEvent.dragStart(f.image, { dataTransfer: {} })).toBe(true)
  expect(f.actions.reportFailure).not.toHaveBeenCalled()
})

it('cancels HTML dragging when the prepared native operation takes over', async () => {
  const f = fixture()
  f.prepared.start.mockReturnValue(false)
  await act(async () => { fireEvent.pointerEnter(f.image) })
  expect(fireEvent.dragStart(f.image, { dataTransfer: {} })).toBe(false)
  fireEvent.click(f.image, { detail: 1 })
  expect(f.open).not.toHaveBeenCalled()
  fireEvent.click(f.image, { detail: 0 })
  expect(f.open).toHaveBeenCalledOnce()
  fireEvent.click(f.image, { detail: 1 })
  expect(f.open).toHaveBeenCalledTimes(2)
})

it('preserves keyboard activation after drag end', async () => {
  const f = fixture()
  await act(async () => { fireEvent.pointerEnter(f.image) })
  fireEvent.dragStart(f.image, { dataTransfer: {} })
  fireEvent.dragEnd(f.image)
  fireEvent.click(f.image, { detail: 0 })
  expect(f.open).toHaveBeenCalledOnce()
})

it('does not prepare panned, right-button, or empty images', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const f = fixture('')
  await act(async () => { fireEvent.pointerEnter(f.image) })
  expect(fireEvent.dragStart(f.image, { dataTransfer: {} })).toBe(true)
  f.view.rerender(<DraggableImage fileDrag={f.actions} src="/image.png" name="image.png" alt="source" />)
  const image = f.view.getByRole('img')
  fireEvent.pointerDown(image, { button: 2 })
  expect(f.actions.prepare).not.toHaveBeenCalled()
  Object.defineProperty(image, 'draggable', { value: false, configurable: true })
  fireEvent.pointerEnter(image)
  expect(f.actions.prepare).not.toHaveBeenCalled()
  Object.defineProperty(image, 'draggable', { value: true, configurable: true })
  await act(async () => { fireEvent.pointerDown(image, { button: 0 }) })
  expect(f.actions.prepare).toHaveBeenCalledOnce()
})

it('keeps already-cancelled gestures inert and forwards loaded original bytes', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const f = fixture()
  const file = new File(['data'], 'loaded.png', { type: 'image/png' })
  f.view.rerender(<div onDragStartCapture={(event) => { event.preventDefault() }}>
    <DraggableImage fileDrag={f.actions} src="blob:original" name={file.name} original={file} resourceAddress="dsh-resource://file/session/s/a.png" />
  </div>)
  const image = f.view.getByRole('img')
  expect(fireEvent.dragStart(image, { dataTransfer: {} })).toBe(false)
  expect(f.prepared.start).not.toHaveBeenCalled()
  await act(async () => { fireEvent.pointerEnter(image) })
  expect(f.actions.prepare).not.toHaveBeenCalled()
  await act(async () => { fireEvent.pointerDown(image, { button: 0 }) })
  expect(f.actions.prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: 'blob', blob: file, resourceAddress: 'dsh-resource://file/session/s/a.png' }), expect.any(AbortSignal))
})
