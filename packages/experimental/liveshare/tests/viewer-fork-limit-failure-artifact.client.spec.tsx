// @vitest-environment jsdom
/**
 * The assembled viewer page on a branch the Host created but could not limit: what the reader is told,
 * and that the page neither presents that Session as usable nor reaches for another one.
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

describe('Assembled liveshare viewer page on a branch the Host could not limit', () => {
  it('leaves the created-but-unusable branch closed and opens none', async () => {
    // The fixture answers every fork the way the Host answers one whose child was created without its
    // read-only limits: a refusal that names the failure, so the view it leaves behind is exercised
    // against the assembled page.
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
    history.replaceState(
      null, '',
      '/?shareId=share-1&fixture&fixtureFork=refused&fixtureForkRefusal=fork-enforcement-failed',
    )
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
      viewerFork: true, forkRefusal: 'fork-enforcement-failed' })
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

    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 30_000 })
    const branches = await screen.findAllByRole(
      'button', { name: '在新对话中分支' }, { timeout: 15_000 },
    )
    const branch = branches.at(-1)
    expect(branch).toBeDefined()
    if (branch === undefined) throw new Error('no branch action on the shared Session')
    await act(async () => { fireEvent.click(branch) })

    // The reader sees the Host's message with its stable code, and no Session to continue in opens. The
    // source Session stays where it was.
    // The shared Client conversation surface no longer states branch refusals through a notice;
    // settle the local RPC round trip and read the view the refusal left behind.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(document.body.textContent).not.toContain('未能完成分支')
    expect(screen.queryByText('分支')).toBeNull()
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    expect(document.body.textContent).toContain('仅可查看')
  }, 180_000)
})
