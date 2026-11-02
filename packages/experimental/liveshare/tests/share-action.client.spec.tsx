// @vitest-environment jsdom
/**
 * The Session-header Share action: the button a local owner opens, the dialog it opens, and the live
 * relay address that dialog starts from.
 */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveshareShareAction } from '../src/client/ShareAction.tsx'
import { en, NS, zh } from '../src/client/locales.ts'
import type { OwnerShares } from '../src/client/owner-shares.ts'
import { accepted, ownerSharesDouble, refused } from './owner-shares-double.client.ts'
import { rememberManagedShare, setManagedShareOpener } from '../src/client/share-navigation.ts'

const SESSION = 'owner-session' as SessionId

// The action reads its copy through the locale seat the browser composition provides.
const locale = new LocaleRuntime(new Context())
locale.register(NS, { zh, en })
locale.setLocale('zh')
const t = locale.bind(NS)

afterEach(cleanup)

/** One Session list carrying the Session the action belongs to, or none at all. */
function list(displayTitle?: string): { byId: Record<string, unknown> } {
  return displayTitle === undefined ? { byId: {} } : { byId: { [SESSION]: { displayTitle } } }
}

/**
 * Render the header action over one scripted Remote namespace.
 * @param shares - Owner share management the action addresses.
 * @param rows - The Session list the action reads its title from.
 * @returns The rendered container.
 */
function renderAction(shares: OwnerShares, rows: { byId: Record<string, unknown> } = list('Review the migration')) {
  const View = LiveshareShareAction as (props: Record<string, unknown>) => ReactNode
  return render(<View
    sessionId={SESSION} shares={shares} t={t}
    useSessions={(selector: (value: unknown) => unknown) => selector(rows)}
  />)
}

describe('Session header Share action', () => {
  it('opens the share dialog and asks the Host for the relay address in force', async () => {
    const { shares, calls } = ownerSharesDouble()
    renderAction(shares)

    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))

    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    // The dialog is told which Session it publishes, including a Session the list does not name.
    expect(calls.map(call => call.method)).toContain('relay')
  })

  it('returns to the share dialog when the manager opens this same Session', async () => {
    const { shares } = ownerSharesDouble({
      list: async () => accepted({ shares: [{
        shareId: 'share', sessionId: SESSION, sessionTitle: 'Review the migration',
        link: 'https://relay.test/?shareId=share', createdAt: '2026-09-05T00:00:00Z', online: true,
      }] as never }),
    })
    renderAction(shares)
    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))
    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['dialog.manage']))
    const manage = await screen.findByRole('button', { name: zh['manage.open'] })
    fireEvent.click(manage)
    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    expect(screen.queryByText(zh['manage.title'])).toBeNull()
  })

  it('asks workspace navigation to open another Session selected in the manager', async () => {
    const open = vi.fn()
    setManagedShareOpener(open)
    const { shares } = ownerSharesDouble({
      list: async () => accepted({ shares: [{
        shareId: 'other', sessionId: 'other-session', sessionTitle: 'Other session',
        link: 'https://relay.test/?shareId=other', createdAt: '2026-09-05T00:00:00Z', online: true,
      }] as never }),
    })
    renderAction(shares)
    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))
    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['dialog.manage']))
    const manage = await screen.findByRole('button', { name: zh['manage.open'] })
    fireEvent.click(manage)
    expect(open).toHaveBeenCalledWith('other-session')
    await waitFor(() => { expect(screen.getByText('Other session')).toBeTruthy() })
  })

  it('opens the share dialog when the manager left a request for this Session', async () => {
    rememberManagedShare(SESSION)
    const { shares } = ownerSharesDouble()
    renderAction(shares)
    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
  })

  it('opens the dialog for a Session the list has not published, titled by its id', async () => {
    const { shares } = ownerSharesDouble()
    renderAction(shares, list())

    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))

    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
  })

  it('starts from an empty address when the Host has none saved', async () => {
    const { shares } = ownerSharesDouble({ relay: async () => accepted({}) })
    renderAction(shares)

    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))

    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    expect(screen.getByLabelText(zh['dialog.relay'])).toHaveProperty('value', '')
    expect(screen.getByText(zh['dialog.addressHint'])).toBeTruthy()
  })

  it('titles the dialog by the Session id when its listed row has no display title', async () => {
    const { shares } = ownerSharesDouble()
    renderAction(shares, { byId: { [SESSION]: {} } })

    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))

    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
  })

  it('opens the dialog when the Host fails to report its relay address', async () => {
    const { shares } = ownerSharesDouble({ relay: async () => { throw new Error('relay unavailable') } })
    renderAction(shares)

    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))

    // Typing the address is still possible: a failed read is not a reason to keep the dialog closed.
    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    expect(screen.getByText(zh['dialog.create'])).toBeTruthy()
  })

  it('opens the dialog when the Host answers that it could not read the relay address', async () => {
    const { shares } = ownerSharesDouble({
      relay: async () => refused('liveshareShares/invalid-relay-url', {}),
    })
    renderAction(shares)

    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))

    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    expect(screen.getByText(zh['dialog.create'])).toBeTruthy()
  })

  it('moves from the share dialog to share management, which closes back to the header', async () => {
    const { shares } = ownerSharesDouble()
    renderAction(shares)

    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))
    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['dialog.manage']))

    // The management surface lists this host's shares; the dialog it replaced is gone.
    await waitFor(() => { expect(screen.getByText(zh['manage.title'])).toBeTruthy() })
    expect(screen.queryByText(zh['dialog.title'])).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: zh['manage.done'] })[0] as HTMLElement)
    await waitFor(() => { expect(screen.queryByText(zh['manage.title'])).toBeNull() })
  })

  it('closes the share dialog without publishing anything', async () => {
    const { shares, calls } = ownerSharesDouble()
    renderAction(shares)

    fireEvent.click(screen.getByRole('button', { name: zh['header.action'] }))
    await waitFor(() => { expect(screen.getByText(zh['dialog.title'])).toBeTruthy() })
    // A fresh dialog states no link yet, so its close control is the cancel affordance.
    fireEvent.click(screen.getAllByRole('button', { name: zh['dialog.cancel'] })[0] as HTMLElement)

    await waitFor(() => { expect(screen.queryByText(zh['dialog.title'])).toBeNull() })
    expect(calls.map(call => call.method)).not.toContain('create')
  })
})
