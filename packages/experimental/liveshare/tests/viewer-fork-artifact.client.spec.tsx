// @vitest-environment jsdom
/**
 * The assembled viewer page branching a share the owner allowed: which Session gets the branch action,
 * what the page shows for the child, and what closing the grant again does to both.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFixtureFaces } from './viewer-fixture.client.ts'
import type { FixtureWorld } from './viewer-fixture.client.ts'
import { installViewerInputFixture, promptEcho } from './viewer-input-fixture.client.ts'
import type { ViewerInputFixture } from './viewer-input-fixture.client.ts'
import { installViewerRelay } from './viewer-relay.client.ts'

/** The generated contribution is a build artifact; the mount boundary is what this face test covers. */
vi.mock('@deepseek-ai/dsh-experimental-liveshare/remote', () => ({ default: { package: '@deepseek-ai/dsh-experimental-liveshare', methods: {} } }))

let inputFixture: ViewerInputFixture | undefined
let owner: FixtureWorld | undefined
let stopRelay: (() => Promise<void>) | undefined
let releaseContext: (() => void) | undefined

afterEach(async () => {
  releaseContext?.()
  releaseContext = undefined
  await inputFixture?.dispose()
  await stopRelay?.()
  owner?.dispose()
  inputFixture = undefined
  stopRelay = undefined
  owner = undefined
  cleanup()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
})

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

/** The Relay answer this page reads: the owner's name, build, and the mode this share carries. */
function contextAnswer(mode: { readonly sessionMode: string; readonly sessionModeReason?: string }): Response {
  return Response.json({
    shareId: 'share-1',
    sessionId: 'fx-alpha',
    ownerDisplayName: 'Owner',
    dshVersion: '0.1.5-rc.2+fixture',
    capabilities: {
      readOnly: true,
      ...mode,
    },
  })
}

describe('Assembled liveshare viewer page branching a share', () => {
  it('branches the shared Session into the reader\'s own child, then closes with the grant', async () => {
    inputFixture = installViewerInputFixture()
    history.replaceState(null, '', '/?shareId=share-1&fixture&fixtureFork=viewer')
    const container = document.createElement('div')
    container.id = 'root'
    document.body.replaceChildren(container)
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('EventSource', class { addEventListener(): void {} close(): void {} })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => { callback(0) }, 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true })
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    // The share's own answer is the page's only read of what the owner granted; every other request
    // this page makes reaches the scripted owner behind the stand-in Relay.
    // The share's answer as the Relay reports it: granting a branch, then narrowing back to view-only,
    // then stopping the share outright — the page follows whichever verdict is current.
    let mode: { readonly sessionMode: string; readonly sessionModeReason?: string } =
      { sessionMode: 'fork-readonly' }
    let releaseAnswer: (() => void) | undefined
    const answerHeld = new Promise<void>((resolve) => { releaseAnswer = resolve; releaseContext = resolve })
    owner = createFixtureFaces({ viewerSourceGrant: () => mode, controlledReply: true, viewerFork: true })
    stopRelay = installViewerRelay({
      owner: owner.rpc,
      other: (url) => {
        // The page waits for nothing, so this answer is held back until the test has seen the shared
        // Session assembled without it.
        if (url.includes('/__liveshare/context')) return answerHeld.then(() => { owner?.refreshGrants(); return contextAnswer(mode) })
        if (url.endsWith('/health')) return Promise.resolve(Response.json({ release_id: 'release-7' }))
        return Promise.reject(new Error(`Unexpected request: ${url}`))
      },
    })

    await act(async () => {
      await inputFixture?.mount(container, { shareId: 'share-1', sessionId: 'fx-alpha' })
    })

    // The shared Session opens by itself and streams the fixture history, read-only.
    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 30_000 })
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    expect(document.body.textContent).toContain('Read only: you can drive this Session, but you read files inside the share’s scope only and modify nothing.')
    // The read-only page offers no way to change the shared Session's own settings.
    expect(screen.queryByRole('button', { name: /^Access mode/u })).toBeNull()
    // Reordering Sessions and Workspaces is the same Host state rename and delete write, so no row on
    // this page is a drag handle either.
    expect(document.querySelector('[role="treeitem"][draggable="true"]')).toBeNull()
    // Before any branch exists, no row on this page is marked as one.
    expect(screen.queryByText('Fork')).toBeNull()
    // The branch action follows the access snapshot the owner's Gateway sent this reader, not the
    // share's own answer, which is still in flight here.
    await screen.findAllByRole('button', { name: 'Branch into a new conversation' }, { timeout: 15_000 })
    releaseAnswer?.()

    // The owner allowed branching, so the shipped branch action is offered on the shared Session.
    // Each completed turn carries one, and the reader branches from the latest.
    const branches = await screen.findAllByRole(
      'button', { name: 'Branch into a new conversation' }, { timeout: 15_000 },
    )
    const branch = branches.at(-1)
    expect(branch).toBeDefined()
    if (branch === undefined) throw new Error('no branch action on the shared Session')
    await act(async () => { fireEvent.click(branch) })

    // The child opens in the same page: the sidebar names where it came from and states the ceiling the
    // host installed. The share it forked from is a view-tier (`fork-readonly` reads as `view`) one, so
    // this child runs under the read-only fork ceiling and the row states exactly that; a write-tier
    // share's child carries the bounded write ceiling instead, whose host half
    // `readonly-fork-cold-child.spec.ts` covers.
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    }, { timeout: 15_000 })
    const childRow = document.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
    if (childRow === null) throw new Error('fork child sidebar row is not selected')
    const mark = childRow.querySelector<HTMLElement>('[data-slot="sidebar.session.row.leading"] span')
    if (mark === null) throw new Error('fork child lineage marker is missing')
    // The shipped Tooltip listens for pointer events; a hover dispatched as a mouse event never raises
    // its bubble, so the ceiling statement would stay unread.
    await act(async () => { fireEvent.pointerEnter(mark) })
    expect(await screen.findByText('Forked from “Fixture 历史会话”')).toBeDefined()
    await act(async () => { fireEvent.pointerLeave(mark) })
    expect(screen.getAllByRole('button', { name: 'Send message' }).length).toBeGreaterThan(0)
    // Prompting the branch is not reconfiguring it: the child gets no preset seat and no session
    // verbs — no rename, no archive, and no branch of the branch — so its row menu keeps only Copy
    // Session ID, while the shared Session's row still offers the one verb this page may use there.
    expect(screen.queryByRole('button', { name: /^Access mode/u })).toBeNull()
    /**
     * Labels one row's action menu offers, read by opening and closing it.
     * @param row - Session row to read.
     * @returns The menu row labels.
     */
    const menuLabels = async (row: HTMLElement): Promise<string[]> => {
      const trigger = within(row).getByRole('button', { name: /Session actions for/u })
      await act(async () => { fireEvent.click(trigger) })
      const labels = screen.queryAllByRole('menuitem').map(item => item.textContent ?? '')
      await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
      return labels
    }
    expect(await menuLabels(childRow)).toEqual(['Copy Session ID'])
    const sourceRow = document.querySelector<HTMLElement>('[role="treeitem"][data-row-key="session:fx-alpha"]')
    if (sourceRow === null) throw new Error('shared Session row is not listed')
    expect(sourceRow).not.toBe(childRow)
    expect(await menuLabels(sourceRow)).toEqual(['Fork session', 'Copy Session ID'])

    const childId = childRow.dataset.rowKey?.replace(/^session:/u, '')
    if (childId === undefined) throw new Error('scripted Owner child is not listed')
    const userText = 'fork child actual input → Send'
    await inputFixture.send(childId, userText, 'Send message')
    await waitFor(() => { expect(owner?.prompts).toHaveLength(1) })
    const request = owner.prompts[0]
    if (request === undefined) throw new Error('no child prompt at the scripted Owner')
    expect(request).toMatchObject({ sessionId: childId, mode: 'queue', content: [{ type: 'text', text: userText }] })
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    promptEcho(owner.history(childId), request)
    expect(owner.history('fx-alpha').some(event => event.type === 'user/message'
      && Reflect.get(event.data.source, 'rpcId') === request.requestId)).toBe(false)
    await act(async () => { owner?.completeReply(childId) })
    const replyText = `回声：${userText}。这是 fixture 的流式回复，用于验证打字机增长与定稿切换。`
    await waitFor(() => { expect(document.body.textContent).toContain(replyText) }, { timeout: 15_000 })

    await act(async () => { fireEvent.click(sourceRow) })
    await waitFor(() => { expect(document.querySelector('[contenteditable="true"]')).toBeNull() })
    expect(document.body.textContent).not.toContain(replyText)
    await act(async () => { fireEvent.click(childRow) })
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
      expect(document.body.textContent).toContain(replyText)
    })
    expect(owner.prompts).toHaveLength(1)

    // The owner closes the grant. The page re-reads the same answer, and everything that answer
    // carried closes with it: the child's composer goes inert and states the reason, and the shared
    // Session's row loses the one verb the page was holding.
    mode = { sessionMode: 'view', sessionModeReason: 'mode-view' }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    }, { timeout: 15_000 })
    // The access snapshot carries no per-Session refusal code, so the child states the fork verdict the
    // share's own answer names.
    expect(document.body.textContent).toContain('The owner set this share to read only')
    // No Session on the page offers a verb any more: the grant that carried them is gone.
    await waitFor(async () => { expect(await menuLabels(sourceRow)).toEqual(['Copy Session ID']) }, { timeout: 15_000 })
    expect(document.contains(sourceRow)).toBe(true)

    // Opening the shared Session again shows no branch action at all: the grant this page held is
    // gone, and the transcript stays read-only.
    await act(async () => { fireEvent.click(sourceRow) })
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    }, { timeout: 15_000 })
    expect(document.body.textContent).toContain('Read only: you can drive this Session, but you read files inside the share’s scope only and modify nothing.')
    expect(screen.queryAllByRole('button', { name: 'Branch into a new conversation' })).toHaveLength(0)

    // The owner allows branching again: the page follows the answer it now holds rather than the one
    // it was assembled with, so the shipped action comes back.
    mode = { sessionMode: 'fork-readonly' }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => {
      expect(screen.queryAllByRole('button', { name: 'Branch into a new conversation' }).length)
        .toBeGreaterThan(0)
    }, { timeout: 15_000 })
    // The sidebar row follows the same answer, and shows it again on the Session it belongs to.
    await waitFor(async () => {
      expect(await menuLabels(sourceRow)).toEqual(['Fork session', 'Copy Session ID'])
    }, { timeout: 15_000 })
    // Negative control: restoring source branching never revives a revoked child, and the child states
    // the fork verdict rather than the view tier's note, which would claim a reach it lost.
    await act(async () => { fireEvent.click(childRow) })
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).toBeNull()
      expect(document.body.textContent).toContain('The owner does not allow branching this Session')
    })
    expect(owner.prompts).toHaveLength(1)
    await act(async () => { fireEvent.click(sourceRow) })
    await waitFor(() => {
      expect(screen.queryAllByRole('button', { name: 'Branch into a new conversation' }).length).toBeGreaterThan(0)
    })

    // The owner stops the share. The page states the share's own verdict on the composer it is
    // showing — not the read-only placeholder, which would hide the one fact the reader needs — and
    // the branch action goes with it.
    mode = { sessionMode: 'view', sessionModeReason: 'share-stopped' }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => {
      expect(document.body.textContent).toContain('Sharing stopped')
    }, { timeout: 15_000 })
    expect(screen.queryAllByRole('button', { name: 'Branch into a new conversation' })).toHaveLength(0)
  }, 180_000)
})
