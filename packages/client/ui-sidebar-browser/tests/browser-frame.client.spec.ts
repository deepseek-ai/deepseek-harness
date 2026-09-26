import { afterEach, describe, expect, it, vi } from 'vitest'
import { IframeImpl } from '../src/client/browser/IframeImpl.ts'
import { IframePresentation } from '../src/client/view/IframePresentation.ts'

const frames: IframeImpl[] = []

afterEach(async () => {
  await Promise.all(frames.splice(0).map(frame => frame.dispose()))
})

describe('IframeImpl', () => {
  it('owns transient sandbox mode and revision-scoped load state', async () => {
    const persist = vi.fn()
    const presentation = new IframePresentation({ loaded: vi.fn(), failed: vi.fn(), remounted: vi.fn() })
    const frame = new IframeImpl({ initial: undefined, persist, openRequested: vi.fn() }, presentation)
    frames.push(frame)
    const listener = vi.fn()
    const unsubscribe = frame.subscribe(listener)
    try {
      frame.handleLoaded(0)
      expect(frame.getSnapshot().address).toBe('empty')
      frame.sandbox.setEnabled(false)
      frame.sandbox.setEnabled(false)
      expect(frame.getSnapshot().sandboxEnabled).toBe(false)
      expect(frame.getSnapshot().target).toBeUndefined()

      const target = { kind: 'https' as const, url: 'https://example.test/', title: 'example.test' }
      frame.handleLoadFailed(1)
      expect(frame.getSnapshot().error).toBeUndefined()
      frame.loadUrl(target)
      frame.handleLoadFailed(0)
      expect(frame.getSnapshot().error).toBeUndefined()
      frame.handleLoadFailed(1)
      frame.handleLoadFailed(1)
      expect(frame.getSnapshot()).toMatchObject({ target, error: { code: undefined, description: undefined }, loading: false })
      frame.handleLoaded(1)
      expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ navigation: { status: 'known', revision: 1 } }))
      frame.reload()
      expect(frame.getSnapshot()).toMatchObject({ target, error: undefined, loading: true })
      frame.handleLoadFailed(1)
      expect(frame.getSnapshot().error).toBeUndefined()
      expect(listener).toHaveBeenCalled()

      await frame.dispose()
      const stopped = frame.getSnapshot()
      frame.handleLoadFailed(2)
      frame.handleLoaded(2)
      frame.reload()
      frame.loadUrl(target)
      frame.goBack()
      frame.goForward()
      frame.sandbox.setEnabled(true)
      expect(frame.getSnapshot()).toBe(stopped)
    } finally {
      unsubscribe()
    }
  })
})
