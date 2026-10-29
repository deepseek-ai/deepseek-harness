/** The Tencent Meeting section offers each state's next step, the signed-in user, sign-out confirmation, guide rows, and failures. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { CliAccountAction, CliAccountDisplay } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { TencentMeetingState } from '@deepseek-ai/dsh-tencent-meeting-cli/types'
import { expect, it, vi } from 'vitest'
import { presentAccount, type TencentMeetingActions } from '../src/client/account.ts'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { en, zh } from '../src/client/locales.ts'

const OP = 'op' as CliOperationId
const LINK = 'https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture'
const SIGNED_OUT: TencentMeetingState = { account: { state: 'signed-out', skills: 'installed' } }
const CONNECTED: TencentMeetingState = { account: { state: 'connected', userName: '测试用户', skills: 'installed' } }

function fixture(copy: typeof zh = zh) {
  const actions: TencentMeetingActions = {
    start: vi.fn(), cancel: vi.fn(), openAuthorization: vi.fn(), retry: vi.fn(), check: vi.fn(), signIn: vi.fn(), signOut: vi.fn(),
  }
  const show = (view: TencentMeetingState | undefined, page: Partial<ConnectionSnapshot> = {}): CliAccountDisplay =>
    presentAccount({ view, linked: true, stopped: false, busy: false, notice: undefined, ...page }, makeTranslate(copy), actions)
  return { actions, show }
}

const labels = (display: CliAccountDisplay): string[] => (display.actions ?? []).map(action => action.label)
const action = (display: CliAccountDisplay, label: string): CliAccountAction => {
  const found = [...display.actions ?? [], ...(display.notes ?? []).flatMap(note => note.action ?? [])].find(item => item.label === label)
  if (found === undefined) throw new Error(`no ${label} action`)
  return found
}

it('offers the next step while signing in', () => {
  const b = fixture()
  let shown = b.show(SIGNED_OUT)
  expect(shown).toMatchObject({ phase: 'disconnected', detail: zh['detail.disconnected'], notes: [] })
  action(shown, zh['action.connect']).onClick()
  expect(b.actions.signIn).toHaveBeenCalledOnce()

  shown = b.show({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true } })
  expect(shown.status).toBe(zh['step.authorizing'])
  expect(labels(shown)).toEqual([zh['action.cancel']])
  shown = b.show({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true, authorizationUrl: LINK } })
  expect(shown.detail).toBe(zh['detail.authorizing'])
  action(shown, zh['action.open']).onClick()
  action(shown, zh['action.cancel']).onClick()
  expect(b.actions.openAuthorization).toHaveBeenCalledOnce()
  expect(b.actions.cancel).toHaveBeenCalledOnce()

  shown = b.show({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'checking', cancellable: false } })
  expect(shown).toMatchObject({ status: zh['step.connecting'], actions: [] })

  shown = b.show(undefined)
  expect(shown).toMatchObject({ phase: 'checking', actions: [], notes: [] })
})

it('names the signed-in user and asks before signing out', () => {
  const b = fixture()
  let shown = b.show(CONNECTED)
  expect(shown.detail).toBe(zh['detail.connected'].replace('{name}', '测试用户'))
  const signOut = action(shown, zh['action.signOut'])
  expect(signOut.confirm).toEqual({ title: zh['signOut.title'], body: zh['signOut.body'], label: zh['action.signOut'] })
  signOut.onClick()
  expect(b.actions.signOut).toHaveBeenCalledOnce()

  shown = b.show({ ...CONNECTED, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', cancellable: false } })
  expect(shown).toMatchObject({ status: zh['step.signing-out'], actions: [] })
})

it.each([['zh', zh], ['en', en]] as const)('reports a failed sign-in with its command in %s', (_locale, copy) => {
  const b = fixture(copy)
  let shown = b.show({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 1 } } })
  expect(shown.failure).toEqual({ text: copy.failed, command: { command: 'auth-login', exitCode: 1 } })
  expect(labels(shown)).toEqual([copy['action.connect']])

  shown = b.show({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } })
  expect(shown.failure).toBeUndefined()
})

it('retries an unconfirmed sign-in by checking again', () => {
  const b = fixture()
  const shown = b.show({ account: { state: 'unverified', skills: 'installed' } })
  expect(shown.detail).toBe(zh['detail.unavailable'])
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.check).toHaveBeenCalledOnce()
})

it('reports a guide that is downloading, and retries a failed download by checking again', () => {
  const b = fixture()
  expect(b.show({ account: { state: 'signed-out', skills: 'downloading' } }).notes).toEqual([{ text: zh['skills.downloading'] }])
  const shown = b.show({ account: { state: 'signed-out', skills: 'failed' } })
  expect(shown.notes?.map(note => note.text)).toEqual([zh['skills.failed']])
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.check).toHaveBeenCalledOnce()
  expect(b.show(SIGNED_OUT).notes).toEqual([])
})

it('explains a stopped Host component and reopens the stream', () => {
  const b = fixture()
  const shown = b.show(undefined, { linked: false, stopped: true })
  expect(shown).toMatchObject({ phase: 'stopped', detail: zh['detail.stopped'] })
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.retry).toHaveBeenCalledOnce()
})

it('answers the activation prompt by signing in', () => {
  const b = fixture()
  const primary = b.show(SIGNED_OUT).actions?.filter(item => item.variant === 'primary' && item.confirm === undefined)
  expect(primary?.map(item => item.onClick)).toEqual([b.actions.signIn])
})
