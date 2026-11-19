/** The sign-in states a provider row's page keeps for its hosts. */
import { expect, it, vi } from 'vitest'
import type { ForgeReadiness } from '@deepseek-ai/dsh-experimental-forge/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { HostSignInStates, type HostReadinessRead } from '../src/client/host-sign-in.ts'

const READY: ForgeReadiness = { state: 'ready', message: null, signIn: null }
const SIGN_IN: ForgeReadiness = { state: 'unauthenticated', message: 'not signed in', signIn: { command: 'glab auth login --hostname gitlab.example.com' } }

/** One readiness read the test answers by hand. */
interface PendingRead {
  readonly host: string
  readonly signal: AbortSignal
  readonly answer: (result: RemoteResult<ForgeReadiness>) => void
}

/** Readiness reads the test answers by hand, in call order. */
function reads() {
  const calls: PendingRead[] = []
  const read = vi.fn<HostReadinessRead>((host, signal) => new Promise((resolve) => { calls.push({ host, signal, answer: resolve }) }))
  return { calls, read }
}

/** Let answered reads reach the store. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

it('shows every host as being checked, then each answer as it arrives', async () => {
  const { calls, read } = reads()
  const signIn = new HostSignInStates(read)
  expect(signIn.states.getSnapshot().size).toBe(0)

  signIn.check(['gitlab.com', 'gitlab.example.com'], true)

  expect(calls.map(call => call.host)).toEqual(['gitlab.com', 'gitlab.example.com'])
  expect([...signIn.states.getSnapshot()]).toEqual([['gitlab.com', { state: 'checking' }], ['gitlab.example.com', { state: 'checking' }]])
  calls[1]?.answer({ ok: true, value: SIGN_IN })
  await settle()
  expect([...signIn.states.getSnapshot()]).toEqual([['gitlab.com', { state: 'checking' }], ['gitlab.example.com', SIGN_IN]])
  calls[0]?.answer({ ok: true, value: READY })
  await settle()
  expect(signIn.states.getSnapshot().get('gitlab.com')).toEqual(READY)
})

it('reports a refused read as a host it could not check, with the reason', async () => {
  const { calls, read } = reads()
  const signIn = new HostSignInStates(read)
  signIn.check(['gitlab.com'], true)

  calls[0]?.answer({ ok: false, error: new RemoteError('gateway/internal', 'The Host did not answer the sign-in read', {}) })
  await settle()

  expect(signIn.states.getSnapshot().get('gitlab.com')).toEqual({
    state: 'unavailable', message: 'The Host did not answer the sign-in read', signIn: null,
  })
})

it('keeps the states it has during a quiet check, shows only new hosts as being checked, and forgets hosts no longer named', async () => {
  const { calls, read } = reads()
  const signIn = new HostSignInStates(read)
  signIn.check(['gitlab.com', 'old.example.com'], true)
  calls[0]?.answer({ ok: true, value: READY })
  calls[1]?.answer({ ok: true, value: SIGN_IN })
  await settle()

  signIn.check(['gitlab.com', 'gitlab.example.com'], false)

  expect([...signIn.states.getSnapshot()]).toEqual([['gitlab.com', READY], ['gitlab.example.com', { state: 'checking' }]])
  calls[2]?.answer({ ok: true, value: SIGN_IN })
  await settle()
  expect(signIn.states.getSnapshot().get('gitlab.com')).toEqual(SIGN_IN)
})

it('ends the reads of an earlier check and drops their answers', async () => {
  const { calls, read } = reads()
  const signIn = new HostSignInStates(read)
  signIn.check(['gitlab.com'], true)

  signIn.check(['gitlab.com'], true)

  expect(calls[0]?.signal.aborted).toBe(true)
  expect(calls[1]?.signal.aborted).toBe(false)
  calls[0]?.answer({ ok: true, value: SIGN_IN })
  await settle()
  expect(signIn.states.getSnapshot().get('gitlab.com')).toEqual({ state: 'checking' })

  signIn.dispose()
  expect(calls[1]?.signal.aborted).toBe(true)
  calls[1]?.answer({ ok: true, value: READY })
  await settle()
  expect(signIn.states.getSnapshot().get('gitlab.com')).toEqual({ state: 'checking' })
})
