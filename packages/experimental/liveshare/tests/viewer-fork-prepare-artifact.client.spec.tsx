// @vitest-environment jsdom
/**
 * The assembled viewer page prompting the branch it already owns while the Host cannot prepare it: what
 * the reader is told, and that the branch stays unstarted with no second branch made.
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

describe('Assembled liveshare viewer page prompting an unprepared branch', () => {
  it('states the failed preparation and leaves the branch unstarted', async () => {
    // The fixture answers every prompt the way the Host answers one into a branch it could not
    // prepare, so the page's own copy for that code and the view it leaves behind are exercised
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
      '/?shareId=share-1&fixture&fixtureFork=viewer'
      + '&fixturePrompt=reject&fixturePromptCode=fork-prepare-failed',
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
      viewerFork: true, rejectPrompt: true, rejectPromptCode: 'fork-prepare-failed' })
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

    // Branching gives this page a branch of its own, and that branch is the Session the reader writes:
    // the only composer this page can type into.
    const composer = await waitFor(() => {
      const editable = document.querySelector('[contenteditable="true"]')
      expect(editable).not.toBeNull()
      return editable as HTMLElement
    }, { timeout: 15_000 })
    const childRow = document.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
    const childId = childRow?.dataset.rowKey?.replace(/^session:/u, '')
    if (childId === undefined) throw new Error('scripted Owner child is not listed')
    await inputFixture.send(childId, 'hello', '发送消息')

    // The reader sees why the action did not run as the Host's message with its stable code; the branch
    // it already owns is neither running nor replaced: one branch row, no Stop, and the draft stays.
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'preparing this fork failed: token=FIXTURE_ONLY_NOT_A_REAL_CREDENTIAL; file=/private/unshared-fixture/credential.txt; url=https://internal.invalid/creds (fork-prepare-failed)',
      )
    }, { timeout: 15_000 })
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
    expect(document.querySelectorAll('[data-slot="sidebar.session.row.leading"] span')).toHaveLength(1)
    expect(document.querySelector('[role="treeitem"][aria-selected="true"]')).toBe(childRow)
    expect(composer.textContent).toContain('hello')
  }, 180_000)
})
