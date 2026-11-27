// @vitest-environment jsdom
/** Slideshow ownership transfers from document mount to letterboxed video and back without frame pulls. */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test.each(['stop', 'fullscreen', 'ended'] as const)('slideshow %s returns to the last shown slide with a document mount', async (ending) => {
  await using f = officeViewFixture('presentation')
  await f.flush()
  expect(f.view.baseElement.querySelector('[data-office-surface]')?.getAttribute('data-dsh-frame-mount')).toBe('video')
  await f.play()
  expect(f.view.baseElement.querySelector('[data-office-surface]')?.getAttribute('data-dsh-frame-mount')).toBe('video')
  expect(f.remote.presentation).toHaveBeenCalledWith('doc', expect.objectContaining({ action: 'stream', enabled: true, generation: expect.any(Number) as number }))
  const mount = f.view.baseElement.querySelector<HTMLElement>('[data-office-surface]')!
  expect(Number.parseFloat(mount.style.width) / Number.parseFloat(mount.style.height)).toBeCloseTo(16 / 9)
  await f.emit({ kind: 'presentation', part: 1, ended: false })
  expect(document.fullscreenElement).not.toBeNull()
  if (ending === 'stop') fireEvent.click(screen.getByRole('button', { name: en.stop }))
  else if (ending === 'fullscreen') act(() => { f.fullscreen.change(null) })
  else await f.emit({ kind: 'presentation', part: 1, ended: true })
  await f.flush()
  expect(document.fullscreenElement).toBeNull()
  expect(f.remote.presentation).toHaveBeenCalledWith('doc', expect.objectContaining({ action: 'stream', enabled: false }))
  expect(f.remote.presentation).toHaveBeenCalledWith('doc', { action: 'stop' })
  expect(f.remote.part).toHaveBeenCalledWith('doc', 1)
  expect(f.view.baseElement.querySelector('[data-office-surface]')?.getAttribute('data-dsh-frame-mount')).toBe('video')
  expect([mount.style.left, mount.style.top, mount.style.width, mount.style.height]).toEqual(['', '', '', ''])
})

test('playing forwards pause and navigation, and a failed fullscreen entry starts no stream', async () => {
  const f = officeViewFixture('presentation')
  try {
    await f.flush(); await f.play()
    fireEvent.click(screen.getByRole('button', { name: en.pause })); await f.flush()
    expect(f.remote.presentation).toHaveBeenCalledWith('doc', { action: 'pause', paused: true })
    fireEvent.keyDown(screen.getByLabelText(en.editor), { key: 'ArrowRight' }); await f.flush()
    expect(f.remote.presentation).toHaveBeenCalledWith('doc', { action: 'next' })
  } finally { await f.close() }
  await using refused = officeViewFixture('presentation')
  await refused.flush()
  vi.spyOn(Element.prototype, 'requestFullscreen').mockRejectedValueOnce(new Error('fullscreen refused'))
  await refused.play()
  expect(refused.remote.presentation).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('fullscreen refused')
})

test('stopping before the first slideshow viewport exits fullscreen without advancing the frame clock', async () => {
  await using f = officeViewFixture('presentation')
  await f.flush()
  await act(async () => { f.presentation()!.play() })
  expect(document.fullscreenElement).not.toBeNull()
  expect(f.connection.frameForwardingSession(f.opened.documentId)!.rx.viewport?.visible).toBe(false)
  await act(async () => { screen.getByRole('button', { name: en.stop }).click() })
  expect(document.fullscreenElement).toBeNull()
  expect(f.remote.presentation).toHaveBeenCalledWith(f.opened.documentId, { action: 'stop' })
  expect(f.remote.presentation).not.toHaveBeenCalledWith(f.opened.documentId, expect.objectContaining({ action: 'stream' }))
  expect(f.onFailure).not.toHaveBeenCalled()
})
