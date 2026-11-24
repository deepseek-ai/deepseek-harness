// @vitest-environment jsdom
/** The General settings switch follows the accepted Host value and reports refused or failed writes. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SettingsRow, type CardSettings } from '../src/client/SettingsRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
type Props = Parameters<typeof SettingsRow>[0]

function fixture(snapshot: Partial<ConfigFormSnapshot<CardSettings>> = {}) {
  let current: ConfigFormSnapshot<CardSettings> = {
    status: 'ready', value: { enabled: true }, base: {}, user: {}, revision: 0, writable: true, ...snapshot,
  }
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const setEnabled = vi.fn(async (enabled: boolean) => {
    current = { ...current, value: { enabled } }
    for (const listener of listeners) listener()
    return true
  })
  const props = { useCardSettings: bindSnapshotSelector(form), setEnabled, t: makeTranslate(en) } as Props
  return { props, setEnabled }
}

it('shows the accepted value with its copy and writes a toggle', async () => {
  const { props, setEnabled } = fixture()
  render(<SettingsRow {...props} />)
  expect(screen.getByText(en['settings.title'])).toBeTruthy()
  expect(screen.getByText(en['settings.description'])).toBeTruthy()
  expect(screen.queryByText(en['settings.details'])).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['settings.detailsLabel'] }))
  expect(screen.getByRole('tooltip').textContent).toBe(en['settings.details'])
  const toggle = screen.getByRole('switch', { name: en['settings.title'] })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
  expect(setEnabled).toHaveBeenCalledWith(false)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['refused', 'rejected'] as const)('keeps the accepted value and reports a %s write', async (failure) => {
  const { props, setEnabled } = fixture()
  if (failure === 'refused') setEnabled.mockResolvedValueOnce(false)
  else setEnabled.mockRejectedValueOnce(new Error('Disconnected'))
  render(<SettingsRow {...props} />)
  fireEvent.click(screen.getByRole('switch'))
  expect((await screen.findByRole('alert')).textContent).toBe(en['settings.error'])
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

it('disables the switch while a write is pending and until the Host value is ready and writable', async () => {
  const { props, setEnabled } = fixture()
  const pending = Promise.withResolvers<boolean>()
  setEnabled.mockReturnValueOnce(pending.promise)
  render(<SettingsRow {...props} />)
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => { expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true) })
  pending.resolve(true)
  await waitFor(() => { expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false) })
  cleanup()
  for (const snapshot of [{ status: 'loading' as const, value: undefined }, { writable: false }]) {
    const view = render(<SettingsRow {...fixture(snapshot).props} />)
    const toggle = view.getByRole('switch')
    expect(toggle.hasAttribute('disabled')).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe(snapshot.status === 'loading' ? 'false' : 'true')
    view.unmount()
  }
})
