// @vitest-environment jsdom
/**
 * The assembled viewer page stopping the one run it owns: the branch it created. The run inside the
 * shared Session belongs to the owner, and no affordance on this page can end it.
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createFixtureFaces } from './viewer-fixture.client.ts'
import { installViewerInputFixture } from './viewer-input-fixture.client.ts'
import { installViewerRelay } from './viewer-relay.client.ts'

/** The generated contribution is a build artifact; the mount boundary is what this face test covers. */
vi.mock('@deepseek-ai/dsh-experimental-liveshare/remote', () => ({ default: { package: '@deepseek-ai/dsh-experimental-liveshare', methods: {} } }))


class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

describe('Assembled liveshare viewer page stopping its own branch', () => {
  it('cancels the branch\u2019s run and leaves the owner\u2019s run alone', async () => {
    // The fixture presents the reader's own branch already running, which is the one run on this page
    // the reader may end; the shared Session is running too, and that run is the owner's.
    const inputFixture = installViewerInputFixture()
    const owned: { disposeOwner?: () => void; stopRelay?: () => Promise<void> } = {}
    onTestFinished(async () => {
      await inputFixture.dispose()
      await owned.stopRelay?.()
      owned.disposeOwner?.()
      cleanup()
      vi.unstubAllGlobals()
      document.body.replaceChildren()
      document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
    })
    history.replaceState(null, '', '/?shareId=share-1&fixture&fixtureFork=running')
    const container = document.createElement('div')
    container.id = 'root'
    document.body.replaceChildren(container)
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('EventSource', class { addEventListener(): void {} close(): void {} })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => { callback(0) }, 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
    Object.defineProperty(navigator, 'languages', { value: ['zh-CN'], configurable: true })
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
    const owner = createFixtureFaces({ viewerSourceGrant: () => ({ sessionMode: 'fork-readonly' }),
      viewerFork: true, forkRunning: true })
    owned.disposeOwner = () => { owner.dispose() }
    owned.stopRelay = installViewerRelay({
      owner: owner.rpc,
      other: (url) => {
        if (url.includes('/__liveshare/context')) {
          return Promise.resolve(Response.json({
            shareId: 'share-1',
            sessionId: 'fx-alpha',
            ownerDisplayName: 'Owner',
            capabilities: { readOnly: true, sessionMode: 'fork-readonly' },
          }))
        }
        if (url.endsWith('/health')) return Promise.resolve(Response.json({ release_id: 'release-7' }))
        return Promise.reject(new Error(`Unexpected request: ${url}`))
      },
    })

    await act(async () => {
      await inputFixture.mount(container, { shareId: 'share-1', sessionId: 'fx-alpha' })
    })

    // The shared Session is running, and this page offers nothing that could end the owner's run.
    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 30_000 })
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
    expect(screen.queryByRole('button', { name: '发送消息' })).toBeNull()

    // Branching gives this page a Session of its own, and that child carries the reader's run.
    const branches = await screen.findAllByRole(
      'button', { name: '在新对话中分支' }, { timeout: 15_000 },
    )
    const branch = branches.at(-1)
    if (branch === undefined) throw new Error('no branch action on the shared Session')
    await act(async () => { fireEvent.click(branch) })
    const stop = await screen.findByRole('button', { name: '停止生成' }, { timeout: 15_000 })

    // Cancelling it ends that run — the Host's own answer to `cancel` — and hands the composer back
    // for the next prompt, while the run in the shared Session is still the owner's to end.
    await act(async () => { fireEvent.click(stop) })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
    }, { timeout: 15_000 })
    expect(screen.getAllByRole('button', { name: '发送消息' }).length).toBeGreaterThan(0)
  }, 180_000)
})
