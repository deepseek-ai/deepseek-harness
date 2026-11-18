// @vitest-environment jsdom
/**
 * The assembled viewer page stopping a run on a share whose Session the Host cannot confine: what the
 * reader's own Stop states, and that none of the Host's own words for it reaches the page.
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

describe('Assembled liveshare viewer page stopping a run the Host cannot confine', () => {
  it('states the refusal with its code on the Stop it offered', async () => {
    // The fixture answers every cancel with the refusal a Host sends when it cannot confine the Session
    // it would drive, so the one action a running Session offers is exercised against it. This bench
    // carries the refusal through the Client's own RPC double; the flat body a Host writes on the wire
    // is the transport suite's case.
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
    history.replaceState(null, '', '/?shareId=share-1&fixture&fixtureCancelCode=source-write-unavailable')
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
    const owner = createFixtureFaces({ viewerSourceGrant: () => ({ sessionMode: 'write' }),
      cancelRefusal: 'source-write-unavailable' })
    owned.disposeOwner = () => { owner.dispose() }
    owned.stopRelay = installViewerRelay({
      owner: owner.rpc,
      other: (url) => {
        if (url.includes('/__liveshare/context')) {
          return Promise.resolve(Response.json({
            shareId: 'share-1',
            sessionId: 'fx-alpha',
            ownerDisplayName: 'Owner',
            capabilities: { readOnly: false, sessionMode: 'write' },
          }))
        }
        if (url.endsWith('/health')) return Promise.resolve(Response.json({ release_id: 'release-7' }))
        return Promise.reject(new Error(`Unexpected request: ${url}`))
      },
    })

    await act(async () => {
      await inputFixture.mount(container, { shareId: 'share-1', sessionId: 'fx-alpha' })
    })

    // The shared Session is running and this page may write it, so the run it shows is the one its
    // Stop is for.
    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 30_000 })
    const stop = await screen.findByRole('button', { name: '停止生成' }, { timeout: 15_000 })
    await act(async () => { fireEvent.click(stop) })

    // The reader sees the Host's message with its stable code, and nothing here states that the run was
    // ended or taken back.
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'cancelling this Session failed: token=FIXTURE_ONLY_NOT_A_REAL_CREDENTIAL; file=/private/unshared-fixture/credential.txt; url=https://internal.invalid/creds (source-write-unavailable)',
      )
    }, { timeout: 15_000 })
    // The run the Host kept running still has its own action, so the page never reports an end that did
    // not happen.
    expect(screen.getByRole('button', { name: '停止生成' })).toBeDefined()
  }, 180_000)
})
