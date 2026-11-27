// @vitest-environment jsdom
/** Unchanged Office geometry does not mutate ancestors of any FF presenter during scrolling. */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { en } from '../src/client/locales.ts'
import css from '../src/client/Editor.module.css'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

test('video scroll frames leave unchanged scale and page extents alone; zoom writes each once', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const scroll = f.area(), content = scroll.firstElementChild as HTMLElement
  const previews = content.querySelector<HTMLElement>(`.${css.pagePreviews}`)!
  const surface = content.querySelector<HTMLElement>('[data-office-surface]')!
  expect(surface.dataset.dshFrameMount).toBe('video')
  const scale = vi.spyOn(content.style, 'setProperty'), clip = vi.spyOn(previews.style, 'clipPath', 'set')
  for (let frame = 1; frame <= 30; frame++) {
    await act(async () => {
      requestAnimationFrame(() => { scroll.scrollTop = frame; fireEvent.scroll(scroll) })
      await f.env.flush()
    })
  }
  expect.soft(scale.mock.calls.filter(([name]) => name === '--office-content-scale')).toHaveLength(0)
  expect.soft(clip).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: en.zoom }))
  fireEvent.click(screen.getByText('50%', { selector: '[role="menuitem"] *' }))
  await f.flush()
  expect(scale.mock.calls.filter(([name]) => name === '--office-content-scale')).toEqual([['--office-content-scale', String(0.5 / 15)]])
  expect(clip).toHaveBeenCalledTimes(1)
  expect(previews.style.clipPath).toBe("path('M0 0h400v600h-400Z M0 610h400v600h-400Z')")
  expect(surface.dataset.dshFrameMount).toBe('video')
  scale.mockClear(); clip.mockClear()
  for (const rectangles of ['0,0,12000,18000;0,18600,12000,18000', '0,0,12000,18000;0,18600,12000,18000 ']) {
    await act(async () => {
      f.setInfo({ ...f.opened.info, rectangles })
      f.connection.dispatch({ documentId: f.opened.documentId, event: { kind: 'callback', type: 13, payload: '' } })
    })
    await f.flush()
    expect(clip).toHaveBeenCalledTimes(1)
    expect(scale.mock.calls.filter(([name]) => name === '--office-content-scale')).toHaveLength(0)
    expect(previews.style.clipPath).toBe("path('M0 0h400v600h-400Z M0 620h400v600h-400Z')")
  }
})

test('slideshow scroll frames leave letterboxing alone; resizing writes only changed dimensions once', async () => {
  const f = officeViewFixture('presentation')
  const observer = new MutationObserver(() => {})
  try {
    await f.flush(); await f.play()
    const scroll = f.area(), surface = scroll.querySelector<HTMLElement>('[data-office-surface]')!
    expect(surface.dataset.dshFrameMount).toBe('video')
    observer.observe(surface, { attributes: true, attributeFilter: ['style'] })
    const width = vi.spyOn(surface.style, 'width', 'set'), height = vi.spyOn(surface.style, 'height', 'set')
    const left = vi.spyOn(surface.style, 'left', 'set'), top = vi.spyOn(surface.style, 'top', 'set')
    for (let frame = 0; frame < 30; frame++) fireEvent.scroll(scroll)
    expect(observer.takeRecords()).toHaveLength(0)
    for (const write of [width, height, left, top]) expect(write).not.toHaveBeenCalled()
    scroll.dataset.width = '960'
    await act(async () => { f.env.resize() }); await f.flush()
    for (const write of [width, height, left, top]) expect(write).toHaveBeenCalledTimes(1)
    expect(Number.parseFloat(surface.style.width) / Number.parseFloat(surface.style.height)).toBeCloseTo(16 / 9)
    for (const write of [width, height, left, top]) write.mockClear()
    await act(async () => { f.env.resize() }); await f.flush()
    for (const write of [width, height, left, top]) expect(write).not.toHaveBeenCalled()
  } finally { observer.disconnect(); await f.close() }
})
