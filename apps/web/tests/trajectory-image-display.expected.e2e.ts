// @vitest-environment jsdom
// Trajectory image surfaces over the BUILT client graph (the ptc-fixture
// idiom: real bundles via AppWebEntry, keyless RemoteMock transport).
// Opens the fixture history session whose turn 73 carries an image in BOTH a
// user message and an assistant message, and pins the Trajectory surfaces:
// selecting the ledger record renders the shared ui-attachment gallery from
// the durable session-log reference, and the browser URL is the SAME object
// URL Chat resolved — one sessions.attachment read per session attachment.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

/**
 * How long the mounted tree waits out the virtual ledger's scroll-idle timer.
 * jsdom fires no `scrollend`, so `@tanstack/react-virtual` falls back to a
 * debounce it re-arms on every scroll event (`isScrollingResetDelay`, 150ms by
 * default) and its unsubscribe removes only the listeners; a scenario that
 * ends inside that window leaves the timer to re-render the table after vitest
 * has torn this file's jsdom down, where React reads a `window` that is gone.
 * Armed later and with a longer delay than the debounce, this wait always
 * expires after it.
 */
const SCROLL_IDLE_DRAIN_MS = 400

/** Open the fixture history session and wait for the Chat gallery to load. */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const group = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (group === null || group === undefined) throw new Error('fixture Workspace group missing')
  if (group.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(within(group).getByText('fixture'))
    await waitFor(() => {
      expect(group.getAttribute('aria-expanded')).toBe('true')
    })
  }
  const session = await within(tree).findByText('Fixture 历史会话')
  fireEvent.click(session)
  await waitFor(() => {
    expect(document.querySelectorAll('[data-align] img').length).toBeGreaterThan(0)
  }, { timeout: 10_000 })
}

/** Scroll the virtual ledger until the row whose text contains `needle` mounts. */
async function scrollRowIntoWindow(needle: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (document.querySelectorAll('tr[data-trajectory-row-key]').length === 0) {
      throw new Error('trajectory rows not mounted')
    }
  }, { timeout: 10_000 })
  const pane = document.querySelector('[data-trajectory-scroll] table')?.parentElement
  if (!(pane instanceof HTMLElement)) throw new Error('trajectory scroll pane missing')
  const findRow = (): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('tr[data-trajectory-row-key]')]
      .find(row => row.textContent?.includes(needle))
  let mounted = false
  for (let top = 0; !mounted && top <= 40_000; top += 1_000) {
    pane.scrollTop = top
    fireEvent.scroll(pane)
    // Let the virtualizer publish the new window before probing.
    await new Promise(resolve => setTimeout(resolve, 25))
    mounted = findRow() !== undefined
  }
  // Nothing scrolls the ledger after this, so draining the scroll-idle
  // debounce here leaves no timer armed for the rest of the scenario. The
  // drained reset re-renders the window, so the row is read afterwards.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, SCROLL_IDLE_DRAIN_MS)) })
  const hit = findRow()
  if (hit === undefined) throw new Error(`trajectory row containing ${JSON.stringify(needle)} never mounted`)
  return hit
}

it('renders durable record images in the Trajectory details panel from the shared cache', async () => {
  // The virtual ledger needs a measurable viewport; jsdom reports zero
  // heights, so pin one and neutralize the imperative tail scroll.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => {},
  })
  mountAssembledApp()
  await openFixtureSession()
  const chatSrc = document.querySelector('[data-align="end"] img')?.getAttribute('src')
  if (chatSrc === null || chatSrc === undefined) throw new Error('chat gallery image missing')

  fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
  const userRow = await scrollRowIntoWindow('历史用户图片')
  fireEvent.click(userRow)

  // Selecting the record opens the details panel; the ui-attachment gallery
  // resolves the durable reference through the SAME per-session cache Chat
  // used, so the object URL is identical — no second attachment read.
  const panel = await screen.findByRole('tabpanel')
  await waitFor(() => {
    expect(within(panel).getAllByRole('img').length).toBeGreaterThan(0)
  }, { timeout: 10_000 })
  expect(within(panel).getAllByRole('img').map(img => ({
    alt: img.getAttribute('alt'),
    scheme: img.getAttribute('src')?.split(':')[0],
    sharedWithChat: img.getAttribute('src') === chatSrc,
  }))).toMatchInlineSnapshot(`
    [
      {
        "alt": "fixture-image.png",
        "scheme": "blob",
        "sharedWithChat": true,
      },
    ]
  `)
})
