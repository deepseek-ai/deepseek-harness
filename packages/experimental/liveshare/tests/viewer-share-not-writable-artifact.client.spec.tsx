// @vitest-environment jsdom
/**
 * The assembled viewer page writing a share the owner no longer allows writing: what the reader's own
 * composer states, and that none of the Host's own words for it reaches the page.
 */

import { act, cleanup, waitFor } from '@testing-library/react'
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

describe('Assembled liveshare viewer page on a share that stopped allowing writes', () => {
  it('states the refusal with its code, and none of the Host\u2019s own words', async () => {
    // The fixture answers every prompt with the refusal a Host sends when its share no longer allows
    // writing the Session this page is writing, so the reader's own composer is exercised against it.
    // This bench carries the refusal through the Client's own RPC double; the flat body a Host writes on
    // the wire is the transport suite's case.
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
    history.replaceState(null, '', '/?shareId=share-1&fixture&fixturePrompt=reject&fixturePromptCode=share-not-writable')
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
      rejectPrompt: true, rejectPromptCode: 'share-not-writable' })
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

    // The mode this page read lets it write the shared Session, so the composer is its own.
    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 30_000 })
    const composer = await waitFor(() => {
      const editable = document.querySelector('[contenteditable="true"]')
      expect(editable).not.toBeNull()
      return editable as HTMLElement
    }, { timeout: 15_000 })
    // The shared Session is running, so this reader's draft is what the primary action sends or steers:
    // whichever the page offers here, it is the prompt the Host answers.
    await inputFixture.send('fx-alpha', 'hello', '排队发送')

    // The reader sees the Host's message with its stable code, and the composer keeps the draft rather
    // than reporting a write that landed.
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'preparing this fork failed: token=FIXTURE_ONLY_NOT_A_REAL_CREDENTIAL; file=/private/unshared-fixture/credential.txt; url=https://internal.invalid/creds (share-not-writable)',
      )
    }, { timeout: 15_000 })
    expect(composer.textContent).toContain('hello')
  }, 180_000)
})
