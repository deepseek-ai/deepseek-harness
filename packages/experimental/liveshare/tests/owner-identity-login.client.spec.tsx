// @vitest-environment jsdom
/** Relay-scoped login through the share dialog's address field and sign-in controls. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LiveshareShareDialog } from '../src/client/ShareDialog.tsx'
import { en } from '../src/client/locales.ts'
import * as login from '../src/client/owner-login.ts'
import { accepted, DOUBLE_RELAY as A, ownerSharesDouble } from './owner-shares-double.client.ts'

const B = 'https://relay-b.example.test'
const link = (relay: string) => `${relay}/authorize`
const ticket = (relay: string) => ({ ok: true as const, value: { state: `state:${relay}`, authorizeUrl: link(relay) } })
const signIn = () => screen.getByRole('button', { name: 'Sign in' })
const manualLink = () => screen.queryByRole('textbox', { name: 'Sign-in link' })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function showDialog(hostA: Partial<login.OwnerLoginHost>) {
  vi.useFakeTimers()
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const cancel = vi.fn(async (_state: string) => {})
  vi.spyOn(login, 'hostOwnerLogin').mockImplementation(relay => ({
    start: async () => ticket(relay),
    status: async () => ({ ok: false, pending: true }),
    cancel,
    ...(relay === A ? hostA : {}),
  }))
  const host = ownerSharesDouble({
    identity: async ({ relay }) => accepted({ state: 'unverified', relay: relay ?? A }),
  })
  const copy: Readonly<Record<string, string>> = en
  await act(async () => {
    render(<LiveshareShareDialog
      sessionId={'session' as SessionId} sessionTitle="Relay switch" defaultRelay={A}
      shares={host.shares} onClose={() => {}} t={key => copy[key] ?? key}
    />)
  })
  await act(async () => { fireEvent.click(signIn()) })
  return { cancel, open, host }
}

async function saveB() {
  const address = screen.getByRole('textbox', { name: 'Share service address' })
  fireEvent.change(address, { target: { value: B } })
  await act(async () => { fireEvent.blur(address) })
  expect(manualLink()).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(signIn()).toHaveProperty('disabled', false)
}

async function signInAtB() {
  await act(async () => { fireEvent.click(signIn()) })
  expect(manualLink()).toHaveProperty('value', link(B))
}

it.each(['verified', 'failed'] as const)('drops A while waiting and ignores its late %s status after B starts', async (outcome) => {
  const answer = Promise.withResolvers<login.OwnerLoginStatusResult>()
  const status = vi.fn(() => answer.promise)
  const { cancel, host } = await showDialog({ status })
  expect(manualLink()).toHaveProperty('value', link(A))
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(status).toHaveBeenCalledWith(`state:${A}`)

  await saveB()
  expect(cancel.mock.calls).toEqual([[`state:${A}`]])
  await signInAtB()
  const reads = host.calls.filter(call => call.method === 'identity').length
  await act(async () => { answer.resolve(outcome === 'verified'
    ? { ok: true, value: { state: 'verified', relay: A } }
    : { ok: false, reason: 'mismatch' }) })
  expect(manualLink()).toHaveProperty('value', link(B))
  expect(host.calls.filter(call => call.method === 'identity')).toHaveLength(reads)
  expect(screen.queryByRole('alert')).toBeNull()

  cleanup()
  expect(cancel.mock.calls).toEqual([[`state:${A}`], [`state:${B}`]])
})

it('drops a late A ticket without opening it or replacing the B link', async () => {
  const answer = Promise.withResolvers<login.OwnerLoginResult<login.OwnerLoginTicket>>()
  const { cancel, open } = await showDialog({ start: () => answer.promise })
  expect(screen.getByText(en['dialog.identity.loginOpening'])).toBeDefined()
  await saveB()
  await signInAtB()
  expect(cancel).not.toHaveBeenCalled()
  await act(async () => { answer.resolve(ticket(A)) })
  expect(cancel.mock.calls).toEqual([[`state:${A}`]])
  expect(open).not.toHaveBeenCalledWith(link(A), '_blank', 'noopener')
  expect(manualLink()).toHaveProperty('value', link(B))
})

it('does not carry an already failed A attempt to the saved B address', async () => {
  await showDialog({ start: async () => ({ ok: false, reason: 'mismatch' }) })
  expect(screen.getByRole('alert').textContent).toBe(en['dialog.identity.loginMismatch'])
  await saveB()
  await signInAtB()
})
