// @vitest-environment jsdom
/** The assembled viewer page mounts the normal DSH client UI for the Session its carrier names. */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFixtureFaces } from './viewer-fixture.client.ts'
import type { FixtureWorld } from './viewer-fixture.client.ts'
import { installViewerInputFixture } from './viewer-input-fixture.client.ts'
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

describe('Assembled liveshare viewer page', () => {
  it('mounts the normal conversation UI for the served session', async () => {
    // The fixture history declares one delivered workspace file, so the page's treatment of that row is
    // exercised beside the rest of the read-only surface.
    inputFixture = installViewerInputFixture()
    history.replaceState(null, '', '/?shareId=share-1&fixture&fixturePresented=1')
    const container = document.createElement('div')
    container.id = 'root'
    document.body.replaceChildren(container)
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('EventSource', class { addEventListener(): void {} close(): void {} })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => { callback(0) }, 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true })
    owner = createFixtureFaces({ presented: true })
    stopRelay = installViewerRelay({ owner: owner.rpc })

    // The carrier names the share and the one Session it presents; the viewer opens that Session by
    // itself because it carries no session list of its own.
    await act(async () => {
      await inputFixture?.mount(container, { shareId: 'share-1', sessionId: 'fx-alpha' })
    })

    await waitFor(() => {
      expect(document.body.textContent).not.toBe('')
    }, { timeout: 30_000 })
    // The page's identity lives in the sidebar's own brand row: the floating banner is gone, and
    // the brand seat is the way back to the share directory.
    expect(document.getElementById('liveshare-home-bar')).toBeNull()
    expect(document.body.style.paddingTop).toBe('')
    // The sidebar keeps the brand identity out of the accessibility tree whenever the page cannot
    // start a Session, so the viewer's home link is read from the DOM rather than by role.
    const brand = document.querySelector<HTMLAnchorElement>('a[aria-label="Back to LiveShare home"]')
    expect(brand).not.toBeNull()
    expect(brand?.getAttribute('href')).toBe('/')
    expect(brand?.textContent).toContain('LiveShare')
    // The shared Session opens by itself: the viewer carries the normal navigation but presents
    // only the one authorized Session.
    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 15_000 })
    // Read-only navigation stays: the sidebar's own Session tree is on screen and lists the shared
    // Session, so a viewer browses the share exactly like an owner browses their sessions.
    const tree = await screen.findByRole('tree', { name: 'Sessions' })
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0)
    // What it must not carry is any action this page cannot perform: no Session or Workspace
    // management entries, and no New Session affordance (the endpoints its access snapshot excludes).
    expect(screen.queryByRole('button', { name: /^New session in / })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Workspace actions for / })).toBeNull()
    // A Session row keeps its menu for Copy Session ID, and every write verb in it hides itself.
    const rowMenu = screen.getAllByRole('button', { name: /^Session actions for / })[0]
    if (rowMenu === undefined) throw new Error('no Session row menu')
    await act(async () => { fireEvent.click(rowMenu) })
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Copy Session ID'])
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(document.body.textContent).not.toContain('Fork session')
    expect(document.body.textContent).not.toContain('Archive session')
    // Global settings belong to the owner's DSH, so the viewer page boots no settings surface at
    // all: the row that opens it comes from a module this roster never carries, and its label —
    // `settings.trigger` in ui-settings-general — is what a booted one would be named.
    expect(screen.queryByRole('button', { name: /^(设置|Settings)$/u })).toBeNull()
    // No write affordance reaches a viewer: the framework's own composer block makes the editor
    // non-editable and states why, and the session management verbs belong to the owner's DSH,
    // which refuses them server-side anyway.
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    // This page never read an answer from the share, so it states that the share's state is
    // unconfirmed instead of presenting an access it was never told it holds.
    expect(document.body.textContent).toContain('could not be confirmed')
    expect(document.body.textContent).not.toContain('仅可查看')
    // The fixture Session is running, and a viewer cannot interrupt the owner's generation: the
    // composer offers neither Stop nor Send.
    expect(screen.queryByRole('button', { name: 'Stop generating' })).toBeNull()
    expect(screen.queryByRole('button', { name: /发送|Send/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /附件|Attach|上传|Upload/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /重命名|Rename|归档|Archive|删除|Delete|Fork/ })).toBeNull()
    // The model this Session runs on is stated where a DSH user looks for it, and it is a label: the
    // reader cannot change the owner's model, but nothing here hides which one the owner chose.
    await waitFor(() => { expect(document.querySelector('[data-liveshare-viewer-seat="model"]')).not.toBeNull() })
    const modelSeat = document.querySelector<HTMLElement>('[data-liveshare-viewer-seat="model"]')
    expect(modelSeat?.tagName).toBe('SPAN')
    expect(modelSeat?.textContent).toMatch(/deepseek/iu)
    expect(modelSeat?.querySelector('button, select, [role="button"], [role="combobox"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /model|模型/iu })).toBeNull()
    // The turn tail is on screen, and it offers no branch action: this page cannot write, so the
    // Chat surface never registers one for the shared Session.
    expect(document.querySelector('[data-actions-reveal]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Branch into a new conversation' })).toBeNull()
    // The assembled conversation renders the fixture history through the real presentation plugins:
    // a user turn, an assistant turn whose Markdown became a highlighted code block, and a tool card.
    expect(document.body.textContent).toContain('问题 51：fixture 历史消息')
    expect(document.body.textContent).toContain('Tool call')
    const codeBlock = document.querySelector('pre.shiki')
    expect(codeBlock).not.toBeNull()
    expect(codeBlock?.querySelector('code')).not.toBeNull()
    expect(document.body.textContent).toContain('echo · turn 52')
    expect(document.querySelectorAll('[data-sample="bash"]').length).toBeGreaterThan(0)
    // A delivered file the transcript declares stays readable — its name and the sidebar preview —
    // and the menu that would open the file on the owner's machine stays closed.
    const deliveredRow = document.querySelector<HTMLElement>('[data-presented-files-row]')
    expect(deliveredRow).not.toBeNull()
    expect(within(deliveredRow as HTMLElement).getByText('demo.txt')).toBeDefined()
    expect(within(deliveredRow as HTMLElement).getByRole('button', { name: 'Preview notes/demo.txt in sidebar' }))
      .toBeDefined()
    // The native-open action stays absent while the Host desktop is unavailable, so the row carries
    // no menu control at all rather than a disabled one.
    expect(within(deliveredRow as HTMLElement).queryByRole(
      'button', { name: 'More ways to open' },
    )).toBeNull()

    // Read-only navigation reaches earlier history: the shipped control loads the previous page from
    // the Host over the same allowlisted read the rest of the transcript uses.
    expect(document.body.textContent).not.toContain('问题 50')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load earlier' })) })
    await waitFor(() => {
      expect(document.body.textContent).toContain('问题 50')
    }, { timeout: 15_000 })

    // An attachment the transcript carries is readable too: the page reads the durable bytes through
    // the allowlisted attachment read and displays them the same way the owner's page does.
    await waitFor(() => {
      const images = [...document.querySelectorAll<HTMLImageElement>('img')]
      expect(images.some(image => image.src.startsWith('data:image/png')
        || image.src.startsWith('blob:')))
        .toBe(true)
    }, { timeout: 15_000 })

    // A file path in the transcript stays readable, and opening it names the reader's own situation:
    // this page claims workspace-file addresses with its own tab type, whose body states that a share
    // hands over paths rather than contents, and the page must not hand the reader the type
    // registry's wiring message instead.
    const fileLinks = [...document.querySelectorAll<HTMLButtonElement>('button[class*="fileLink"]')]
    expect(fileLinks.length).toBeGreaterThan(0)
    await act(async () => { fireEvent.click(fileLinks[0] as HTMLButtonElement) })
    await waitFor(() => {
      expect(document.body.textContent).toContain('This page cannot open workspace files')
    }, { timeout: 15_000 })
    expect(document.body.textContent).not.toContain('no registered tab type claims')
  }, 120_000)
})
