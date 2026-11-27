// @vitest-environment jsdom
/** Standard Fullscreen API helpers for Office slideshow views and occlusion checks. */
import { afterEach, expect, test } from 'vitest'
import { exitElementFullscreen, isOccludedByFullscreen, requestElementFullscreen } from '../src/client/fullscreen.ts'
import { fakeFullscreen } from './helpers/frame-forwarding.client.ts'

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

test('reports occlusion when another element holds fullscreen and rejects competing requests', async () => {
  const first = document.createElement('div')
  const second = document.createElement('div')
  // Environments without Fullscreen API (fullscreenElement === undefined) are not occluded.
  expect(isOccludedByFullscreen(first)).toBe(false)
  const fs = fakeFullscreen()
  cleanup = () => { fs.restore() }
  expect(isOccludedByFullscreen(first)).toBe(false)
  await requestElementFullscreen(first)
  expect(document.fullscreenElement).toBe(first)
  expect(isOccludedByFullscreen(first)).toBe(false)
  expect(isOccludedByFullscreen(second)).toBe(true)
  await expect(requestElementFullscreen(second)).rejects.toThrow('Another view is already fullscreen.')
})

test('exits only the element holding fullscreen, tolerating an Escape race and propagating active errors', async () => {
  const fs = fakeFullscreen()
  cleanup = () => { fs.restore() }
  const first = document.createElement('div')
  const second = document.createElement('div')
  await exitElementFullscreen(first)
  expect(fs.exit).not.toHaveBeenCalled()
  await requestElementFullscreen(first)
  await exitElementFullscreen(second)
  expect(fs.exit).not.toHaveBeenCalled()
  // Escape raced with exitFullscreen: fullscreenElement is already null when exit rejects.
  fs.exit.mockImplementationOnce(async () => { fs.change(null); throw new Error('Document not active') })
  await exitElementFullscreen(first)
  expect(document.fullscreenElement).toBeNull()
  // Real exit rejection while fullscreen stays active must propagate.
  await requestElementFullscreen(first)
  fs.exit.mockRejectedValueOnce(new Error('exit refused'))
  await expect(exitElementFullscreen(first)).rejects.toThrow('exit refused')
  await exitElementFullscreen(first)
  expect(document.fullscreenElement).toBeNull()
})
