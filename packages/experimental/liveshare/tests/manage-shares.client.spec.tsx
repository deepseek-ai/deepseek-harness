// @vitest-environment jsdom
/** The global share list: a Session title, its online state, and the button that opens its share dialog. */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import { LiveshareManageSharesDialog, type LiveshareManageSharesDialogProps } from '../src/client/ManageSharesDialog.tsx'
import { en } from '../src/client/locales.ts'
import type { OwnerShareList } from '../src/share-api-types.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { accepted, ownerSharesDouble, refused, requestOf } from './owner-shares-double.client.ts'

afterEach(cleanup)

const translate: LiveshareManageSharesDialogProps['t'] = (key, params) => {
  let result = (en as Readonly<Record<string, string>>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) result = result.replace(`{${name}}`, String(value))
  return result
}

const ROWS = [
  {
    shareId: 'one', sessionId: 'session-one', sessionTitle: 'First session', link: 'https://relay.test/?shareId=one',
    createdAt: '2026-09-05T00:00:00Z', online: true,
  },
  {
    shareId: 'two', sessionId: 'session-two', sessionTitle: 'Second session', link: 'https://relay.test/?shareId=two',
    createdAt: '2026-09-05T00:00:00Z', online: false,
  },
]

/** Mount the manager with one scripted list answer. */
async function showManager(
  answer: () => Promise<RemoteResult<OwnerShareList>>,
  onOpenShare?: (sessionId: string, sessionTitle: string) => void,
  onClose = (): void => {},
  overrides: Parameters<typeof ownerSharesDouble>[0] = {},
) {
  const host = ownerSharesDouble({ list: answer, ...overrides })
  await act(async () => {
    render(<LiveshareManageSharesDialog
      shares={host.shares}
      {...(onOpenShare === undefined ? {} : { onOpenShare })}
      onClose={onClose}
      t={translate}
    />)
  })
  return host
}

describe('Liveshare global share manager', () => {
  it('shows only each Session title and opens that Session share dialog', async () => {
    const opened: string[] = []
    await showManager(async () => accepted({ shares: ROWS as never }), (sessionId, title) => { opened.push(`${sessionId}:${title}`) })
    expect(screen.getByText('First session')).toBeDefined()
    expect(screen.getByText('Second session')).toBeDefined()
    expect(screen.getByText('Online')).toBeDefined()
    expect(screen.getByText('Offline')).toBeDefined()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    const opens = screen.getAllByRole('button', { name: 'Manage' })
    expect(opens).toHaveLength(2)
    await act(async () => { fireEvent.click(opens[0]!) })
    expect(opened).toEqual(['session-one:First session'])
  })

  it('stops one share from its own row after the owner acknowledges the link loss', async () => {
    const host = await showManager(async () => accepted({ shares: ROWS as never }), undefined, () => {}, {
      stop: async () => accepted({ ok: true }),
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: en['manage.cancelShare'] })[0]!)
    })
    const confirm = screen.getByRole('dialog', { name: en['manage.stop.title'] })
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('checkbox', { name: en['manage.stop.acknowledge'] }))
    })
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: en['dialog.stop'] }))
    })
    expect(requestOf(host.calls, 'stop')).toEqual({ shareId: 'one' })
    expect(screen.queryByText('First session')).toBeNull()
    expect(screen.getByText('Second session')).toBeDefined()
  })

  it('states a refused cancellation and keeps the share listed', async () => {
    await showManager(async () => accepted({ shares: ROWS as never }), undefined, () => {}, {
      stop: async () => refused('gateway/internal', {}),
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: en['manage.cancelShare'] })[0]!)
    })
    const confirm = screen.getByRole('dialog', { name: en['manage.stop.title'] })
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('checkbox', { name: en['manage.stop.acknowledge'] }))
    })
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: en['dialog.stop'] }))
    })
    expect(screen.getByRole('alert').textContent).toBe(en['dialog.stopFailed'])
    expect(screen.getByText('First session')).toBeDefined()
  })

  it('cancels the stop confirmation without stopping the share', async () => {
    await showManager(async () => accepted({ shares: ROWS as never }))
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: en['manage.cancelShare'] })[0]!)
    })
    const confirm = screen.getByRole('dialog', { name: en['manage.stop.title'] })
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: en['dialog.cancel'] }))
    })
    expect(screen.queryByRole('dialog', { name: en['manage.stop.title'] })).toBeNull()
    expect(screen.getByText('First session')).toBeDefined()
  })

  it('disables the manage action when the host page cannot navigate', async () => {
    await showManager(async () => accepted({ shares: ROWS as never }))
    for (const button of screen.getAllByRole('button', { name: 'Manage' })) {
      expect(button).toHaveProperty('disabled', true)
    }
  })

  it('ignores a list answer that arrives after the manager closed', async () => {
    const pending = Promise.withResolvers<RemoteResult<OwnerShareList>>()
    const host = ownerSharesDouble({ list: () => pending.promise })
    const view = render(<LiveshareManageSharesDialog shares={host.shares} onClose={() => {}} t={translate} />)
    view.unmount()
    await act(async () => {
      pending.resolve(accepted({ shares: ROWS as never }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(screen.queryByText('First session')).toBeNull()
  })

  it('ignores a list failure that arrives after the manager closed', async () => {
    const pending = Promise.withResolvers<RemoteResult<OwnerShareList>>()
    const host = ownerSharesDouble({ list: () => pending.promise })
    const view = render(<LiveshareManageSharesDialog shares={host.shares} onClose={() => {}} t={translate} />)
    view.unmount()
    await act(async () => {
      pending.resolve(refused('gateway/internal', {}))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a direct list rejection after the manager closed', async () => {
    const pending = Promise.withResolvers<RemoteResult<OwnerShareList>>()
    const host = ownerSharesDouble({ list: () => pending.promise })
    const view = render(<LiveshareManageSharesDialog shares={host.shares} onClose={() => {}} t={translate} />)
    view.unmount()
    await act(async () => {
      pending.reject(new Error('gateway lost'))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('states loading, empty, and refused lists', async () => {
    const pending = Promise.withResolvers<RemoteResult<OwnerShareList>>()
    await showManager(() => pending.promise)
    expect(screen.getByText(en['manage.loading'])).toBeDefined()
    await act(async () => { pending.resolve(accepted({ shares: [] })) })
    expect(screen.getByText(en['manage.empty'])).toBeDefined()
    cleanup()

    await showManager(async () => refused('gateway/internal', {}))
    expect(screen.getByRole('alert').textContent).toBe(en['manage.unavailable'])
  })

  it('closes from its Done control', async () => {
    const onClose = vi.fn()
    await showManager(async () => accepted({ shares: [] }), undefined, onClose)
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: en['manage.done'] })[0]!) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
