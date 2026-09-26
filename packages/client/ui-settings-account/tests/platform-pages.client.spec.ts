// @vitest-environment jsdom
/** The shared Platform page request channel: ownership, identity-safe release, and teardown. */
import { expect, it, vi } from 'vitest'
import { createPlatformPages } from '../src/client/platform-pages.ts'

it('ignores a close with no live request', () => {
  const pages = createPlatformPages()
  const listener = vi.fn()
  pages.subscribe(listener)
  pages.close()
  expect(pages.getSnapshot()).toBeNull()
  expect(listener).not.toHaveBeenCalled()
})

it('publishes each request and clears it on close, retiring the owner once', () => {
  const pages = createPlatformPages()
  const listener = vi.fn()
  const unsubscribe = pages.subscribe(listener)
  const first = vi.fn()
  pages.open('usage', first)
  expect(pages.getSnapshot()).toEqual({ page: 'usage' })
  pages.close()
  expect(pages.getSnapshot()).toBeNull()
  expect(first).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledTimes(2)
  // A close after the request is gone neither republishes nor retires again.
  pages.close()
  expect(first).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledTimes(2)
  unsubscribe()
  pages.open('top-up', vi.fn())
  expect(listener).toHaveBeenCalledTimes(2)
})

it('retires the previous owner on a newer request and ignores its stale release', () => {
  const pages = createPlatformPages()
  const first = vi.fn()
  const releaseFirst = pages.open('usage', first)
  const second = vi.fn()
  pages.open('top-up', second)
  expect(first).toHaveBeenCalledOnce()
  expect(pages.getSnapshot()).toEqual({ page: 'top-up' })
  // The retired owner's cleanup must not clear the page that replaced it.
  releaseFirst()
  expect(pages.getSnapshot()).toEqual({ page: 'top-up' })
  expect(second).not.toHaveBeenCalled()
})

it('clears the live request on release without retiring its owner', () => {
  const pages = createPlatformPages()
  const owner = vi.fn()
  const release = pages.open('top-up', owner)
  release()
  expect(pages.getSnapshot()).toBeNull()
  expect(owner).not.toHaveBeenCalled()
  // A second release is a no-op.
  release()
  expect(pages.getSnapshot()).toBeNull()
})

it('drops the live request on teardown without retiring its owner', () => {
  const pages = createPlatformPages()
  const listener = vi.fn()
  pages.subscribe(listener)
  const owner = vi.fn()
  pages.open('usage', owner)
  pages.dispose()
  expect(pages.getSnapshot()).toBeNull()
  expect(owner).not.toHaveBeenCalled()
  expect(listener).toHaveBeenCalledTimes(2)
  // Disposing an already-empty channel stays silent.
  pages.dispose()
  expect(listener).toHaveBeenCalledTimes(2)
})

it('keeps publishing when one subscriber throws', () => {
  const pages = createPlatformPages()
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const healthy = vi.fn()
  pages.subscribe(() => { throw new Error('bad subscriber') })
  pages.subscribe(healthy)
  pages.open('usage', vi.fn())
  expect(healthy).toHaveBeenCalledOnce()
  expect(pages.getSnapshot()).toEqual({ page: 'usage' })
  expect(consoleError).toHaveBeenCalled()
  consoleError.mockRestore()
})
