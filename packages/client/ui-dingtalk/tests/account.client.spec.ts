/** The DingTalk section offers each state's next step, the signed-in user, a sign-out confirmation, and failure guidance. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { CliAccountAction, CliAccountDisplay } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { DingtalkState } from '@deepseek-ai/dsh-dingtalk-cli/types'
import { expect, it, vi } from 'vitest'
import { presentAccount, type DingtalkActions } from '../src/client/account.ts'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { en, zh } from '../src/client/locales.ts'

const OP = 'op' as CliOperationId
const LINK = 'https://login.dingtalk.com/oauth2/auth?client_id=fixture&state=fixture'
const SIGNED_OUT: DingtalkState = { account: { state: 'signed-out' } }
const CONNECTED: DingtalkState = { account: { state: 'connected', userName: '测试用户', corpName: '测试组织' } }

function fixture(copy: typeof zh = zh) {
  const actions: DingtalkActions = {
    start: vi.fn(), cancel: vi.fn(), openAuthorization: vi.fn(), retry: vi.fn(), check: vi.fn(), signIn: vi.fn(), signOut: vi.fn(),
  }
  const show = (view: DingtalkState | undefined, page: Partial<ConnectionSnapshot> = {}): CliAccountDisplay =>
    presentAccount({ view, linked: true, stopped: false, busy: false, notice: undefined, ...page }, makeTranslate(copy), actions)
  return { actions, show }
}

const labels = (display: CliAccountDisplay): string[] => (display.actions ?? []).map(action => action.label)
const action = (display: CliAccountDisplay, label: string): CliAccountAction => {
  const found = display.actions?.find(item => item.label === label)
  if (found === undefined) throw new Error(`no ${label} action`)
  return found
}

it('shows the dws download, then offers the next step while signing in', () => {
  const b = fixture()
  let shown = b.show({ account: { state: 'unchecked' }, operation: { id: OP, kind: 'check', phase: 'downloading', cancellable: false } })
  expect(shown).toMatchObject({ phase: 'checking', status: zh['step.downloading'], actions: [] })

  shown = b.show(SIGNED_OUT)
  expect(shown).toMatchObject({ phase: 'disconnected', detail: zh['detail.disconnected'] })
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
  expect(shown).toMatchObject({ phase: 'checking', status: undefined, actions: [] })
})

it.each<[string, DingtalkState['account'], string]>([
  ['the user and organization', CONNECTED.account, zh['detail.connectedIn'].replace('{name}', '测试用户').replace('{org}', '测试组织')],
  ['the user', { state: 'connected', userName: '测试用户' }, zh['detail.connectedAs'].replace('{name}', '测试用户')],
  ['no name', { state: 'connected' }, zh['detail.connected']],
])('names %s that dws reports', (_name, account, detail) => {
  expect(fixture().show({ account }).detail).toBe(detail)
})

it('asks before signing out', () => {
  const b = fixture()
  const signOut = action(b.show(CONNECTED), zh['action.signOut'])
  expect(signOut.confirm).toEqual({ title: zh['signOut.title'], body: zh['signOut.body'], label: zh['action.signOut'] })
  signOut.onClick()
  expect(b.actions.signOut).toHaveBeenCalledOnce()

  const shown = b.show({ ...CONNECTED, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', cancellable: false } })
  expect(shown).toMatchObject({ status: zh['step.signing-out'], actions: [] })
})

it.each([['zh', zh], ['en', en]] as const)('reports a failed sign-in with the CLI access hint and its command in %s', (_locale, copy) => {
  const b = fixture(copy)
  let shown = b.show({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 2 } } })
  expect(shown.failure).toEqual({ text: copy['failed.signIn'], command: { command: 'auth-login', exitCode: 2 } })
  expect(labels(shown)).toEqual([copy['action.connect']])

  shown = b.show({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } })
  expect(shown.failure).toBeUndefined()
})

it.each<[string, DingtalkState, string]>([
  ['a sign-in dws cannot judge', { account: { state: 'unverified' } }, zh['detail.unavailable']],
  ['a dws download that did not finish', { account: { state: 'not-installed' }, result: { id: OP, kind: 'check', outcome: 'failed' } }, zh['detail.missing']],
])('retries %s by checking again', (_name, view, detail) => {
  const b = fixture()
  const shown = b.show(view)
  expect(shown.detail).toBe(detail)
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.check).toHaveBeenCalledOnce()
})

it('reports a failed check with the generic guidance', () => {
  const shown = fixture().show({ account: { state: 'unchecked' }, result: { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } } })
  expect(shown.failure?.text).toBe(zh.failed)
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
