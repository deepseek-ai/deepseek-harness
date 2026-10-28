// @vitest-environment jsdom
/**
 * The assembled viewer page on a share whose owner granted writing: the shared Session itself becomes
 * writable for that reader, while the Workspace around it and the owner's own management stay put.
 */

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
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

afterEach(async () => {
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

describe('Assembled liveshare viewer page on a writable share', () => {
  it('writes the shared Session, keeps the Workspace out of reach, and closes on a narrower mode', async () => {
    inputFixture = installViewerInputFixture()
    history.replaceState(null, '', '/?shareId=share-1&fixture')
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
    // The share starts read-only; the owner then widens it to writing and narrows it back while this
    // page is open, so both directions reach the surfaces already on screen.
    const answeredModes: string[] = []
    let mode: { readonly sessionMode: string; readonly sessionModeReason?: string } = { sessionMode: 'view' }
    let sourceGrant: { readonly sessionMode: string; readonly sessionModeReason?: string } | undefined
    owner = createFixtureFaces({ viewerSourceGrant: () => sourceGrant ?? mode, controlledReply: true })
    stopRelay = installViewerRelay({
      owner: owner.rpc,
      other: (url) => {
        if (url.includes('/__liveshare/context')) {
          answeredModes.push(mode.sessionMode)
          owner?.refreshGrants()
          return Promise.resolve(Response.json({
            shareId: 'share-1',
            sessionId: 'fx-alpha',
            ownerDisplayName: 'Owner',
            capabilities: { readOnly: true, ...mode },
          }))
        }
        if (url.endsWith('/health')) return Promise.resolve(Response.json({ release_id: 'release-7' }))
        return Promise.reject(new Error(`Unexpected request: ${url}`))
      },
    })

    await act(async () => {
      await inputFixture?.mount(container, { shareId: 'share-1', sessionId: 'fx-alpha' })
    })

    // The shared Session is running, and a read-only share leaves the composer inert with the reason
    // stated: the owner's run is not this page's to end.
    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 30_000 })
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    expect(document.body.textContent).toContain('仅可查看')
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()

    // The owner widens the share to writing: the same page keeps its transcript, and the composer
    // becomes the reader's — editable, with the running turn's own action.
    // Negative control: unknown Owner modes cannot unlock the source.
    mode = { sessionMode: 'future-mode' }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => { expect(answeredModes).toContain('future-mode') }, { timeout: 15_000 })
    expect(document.body.textContent).toContain('仅可查看')
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    expect(owner.prompts).toHaveLength(0)

    // Negative control: a writable page context cannot substitute for the owner's access snapshot,
    // which still excludes prompting the source. The composer stays inert, and because the page's own
    // mode does grant writing it states that the session cannot be driven rather than claiming read-only.
    sourceGrant = { sessionMode: 'future-mode' }
    mode = { sessionMode: 'write' }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => { expect(answeredModes).toContain('write') }, { timeout: 15_000 })
    expect(document.body.textContent).toContain('无法被驱动')
    expect(document.body.textContent).not.toContain('仅可查看')
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    expect(owner.prompts).toHaveLength(0)
    sourceGrant = undefined
    await act(async () => { owner?.refreshGrants() })
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    }, { timeout: 15_000 })
    expect(screen.getByRole('button', { name: '停止生成' })).toBeDefined()
    expect(document.body.textContent).not.toContain('仅可查看')
    // What writing the Session does not carry: the Workspace around it stays the owner's, so no New
    // Session, no Workspace verbs, and no reordering.
    expect(screen.queryByRole('button', { name: '新会话' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^在“/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /^工作区“/u })).toBeNull()
    expect(document.querySelector('[role="treeitem"][draggable="true"]')).toBeNull()
    // The Session's own verbs stay the owner's — the one this page may use there is the branch the
    // mode grants — so the row's menu is not a second way into the owner's Session management: it
    // opens on the branch verb and carries neither rename nor archive.
    const sourceVerbs = screen.getByRole('button', { name: /^会话“/u })
    await act(async () => { fireEvent.click(sourceVerbs) })
    expect(await screen.findByRole('menuitem', { name: '分叉会话' })).toBeDefined()
    expect(screen.queryByRole('menuitem', { name: '重命名' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '归档会话' })).toBeNull()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止生成' })) })
    await waitFor(() => { expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull() })
    expect(owner.cancellations).toEqual(['fx-alpha'])

    const userText = 'source artifact typing → Send 精确消息'
    await inputFixture.send('fx-alpha', userText, '发送消息')
    await waitFor(() => { expect(owner?.prompts).toHaveLength(1) })
    const request = owner.prompts[0]
    if (request === undefined) throw new Error('no source prompt at the scripted Owner')
    expect(request).toMatchObject({ sessionId: 'fx-alpha', mode: 'queue', content: [{ type: 'text', text: userText }] })
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    promptEcho(owner.history('fx-alpha'), request)
    expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe('')
    await act(async () => { owner?.completeReply('fx-alpha') })
    const replyText = `回声：${userText}。这是 fixture 的流式回复，用于验证打字机增长与定稿切换。`
    await waitFor(() => { expect(document.body.textContent).toContain(replyText) }, { timeout: 15_000 })
    expect(owner.history('fx-alpha').filter(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === replyText))).toHaveLength(1)

    await inputFixture.send('fx-alpha', 'held generation for Stop', '发送消息')
    await waitFor(() => { expect(screen.getByRole('button', { name: '停止生成' })).toBeDefined() }, { timeout: 15_000 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止生成' })) })
    await waitFor(() => { expect(owner?.cancellations).toEqual(['fx-alpha', 'fx-alpha']) }, { timeout: 15_000 })
    expect(owner.history('fx-alpha').at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })

    // The owner narrows the share to branching: the shared Session goes back to read-only — the
    // composer is inert and states that fact, and the run's action is gone — while the branch this
    // mode still grants stays on offer.
    mode = { sessionMode: 'fork-readonly' }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    }, { timeout: 15_000 })
    expect(document.body.textContent).toContain('仅可查看')
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '在新对话中分支' }).length).toBeGreaterThan(0)
    const beforeDeniedSend = owner.prompts.length
    const scope = inputFixture.context().get('sessions')?.scope('fx-alpha' as import('@deepseek-ai/dsh-session/types').SessionId)
    if (scope === undefined) throw new Error('source scope is missing after downgrade')
    // Negative control: even the live input API cannot submit after Owner downgrade.
    await act(async () => {
      const input = inputFixture?.context().get('conversation')?.input.for(scope)
      if (input === undefined) throw new Error('real source input is missing after downgrade')
      input.setDraft('must not reach Owner after downgrade')
      input.submit('queue', 'click')
    })
    expect(owner.prompts).toHaveLength(beforeDeniedSend)

    // The owner narrows it once more, to read-only: the branch goes with the mode, and the shared
    // Session stays as read-only as it already was.
    mode = { sessionMode: 'view', sessionModeReason: 'mode-view' }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => {
      expect(screen.queryAllByRole('button', { name: '在新对话中分支' })).toHaveLength(0)
    }, { timeout: 15_000 })
    expect(document.body.textContent).toContain('仅可查看')
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  }, 180_000)
})
