/** The Feishu section offers each state's next step, the linked app, confirmations, and failure guidance. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { CliAccountAction, CliAccountDisplay } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { FeishuAppId, FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'
import { expect, it, vi } from 'vitest'
import { presentAccount, type FeishuActions } from '../src/client/account.ts'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { en, zh } from '../src/client/locales.ts'

const OP = 'op' as CliOperationId
const APP = 'cli_a' as FeishuAppId

function fixture(copy: typeof zh = zh) {
  const actions: FeishuActions = {
    start: vi.fn(), cancel: vi.fn(), openAuthorization: vi.fn(), retry: vi.fn(),
    check: vi.fn(), linkApp: vi.fn(), signIn: vi.fn(), signOut: vi.fn(),
  }
  const show = (view: FeishuState | undefined, page: Partial<ConnectionSnapshot> = {}): CliAccountDisplay =>
    presentAccount({ view, linked: true, stopped: false, busy: false, notice: undefined, ...page }, makeTranslate(copy), actions)
  return { actions, show }
}

const labels = (display: CliAccountDisplay): string[] => (display.actions ?? []).map(action => action.label)
const action = (display: CliAccountDisplay, label: string): CliAccountAction => {
  const found = [...display.actions ?? [], ...(display.notes ?? []).flatMap(note => note.action ?? [])].find(item => item.label === label)
  if (found === undefined) throw new Error(`no ${label} action`)
  return found
}
const text = (key: keyof typeof zh, values: Record<string, string> = {}) =>
  Object.entries(values).reduce((value, [name, replacement]) => value.replace(`{${name}}`, replacement), zh[key])

it('offers the next step for each state', () => {
  const b = fixture()
  let shown = b.show({ account: { state: 'unconfigured' } })
  expect(shown).toMatchObject({ phase: 'disconnected', detail: zh['detail.no-app'], notes: [] })
  action(shown, zh['action.linkApp']).onClick()
  expect(b.actions.linkApp).toHaveBeenCalledOnce()

  shown = b.show({ account: { state: 'unconfigured' }, operation: { id: OP, kind: 'link-app', phase: 'configuring', cancellable: true } })
  expect(shown).toMatchObject({ phase: 'connecting', status: zh['step.configuring'] })
  expect(labels(shown)).toEqual([zh['action.cancel']])

  shown = b.show({ account: { state: 'signed-out', appId: APP } })
  expect(shown.detail).toBe(zh['detail.signed-out'])
  action(shown, zh['action.signIn']).onClick()
  expect(b.actions.signIn).toHaveBeenCalledOnce()

  shown = b.show({ account: { state: 'signed-out', appId: APP }, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true, authorizationUrl: 'https://x.feishu.cn' } })
  expect(shown.detail).toBe(zh['detail.authorizing'])
  action(shown, zh['action.open']).onClick()
  action(shown, zh['action.cancel']).onClick()
  expect(b.actions.openAuthorization).toHaveBeenCalledOnce()
  expect(b.actions.cancel).toHaveBeenCalledOnce()

  shown = b.show({ account: { state: 'signed-out', appId: APP }, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', cancellable: false, authorizationUrl: 'https://x.feishu.cn' } })
  expect(shown).toMatchObject({ status: zh['step.signing-out'], detail: undefined })
  expect(labels(shown)).toEqual([zh['action.open']])

  shown = b.show({ account: { state: 'unverified', appId: APP } })
  expect(shown.detail).toBe(zh['detail.unavailable'])
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.check).toHaveBeenCalledOnce()

  shown = b.show(undefined)
  expect(shown).toMatchObject({ phase: 'checking', actions: [], notes: [] })
})

it.each([['zh', zh], ['en', en]] as const)('reports app-link recovery with its safe diagnostics in %s', (_locale, copy) => {
  const b = fixture(copy)
  let shown = b.show({
    account: { state: 'unconfigured' },
    result: { id: OP, kind: 'link-app', outcome: 'failed', failure: { command: 'config-init', exitCode: 1, type: 'internal', subtype: 'sdk_error' } },
  })
  expect(labels(shown)).toEqual([copy['action.linkApp']])
  expect(shown.failure).toEqual({
    text: copy['failed.linkApp'],
    command: { command: 'config-init', exitCode: 1, type: 'internal', subtype: 'sdk_error' },
    details: ['internal', 'sdk_error'],
  })

  shown = b.show({ account: { state: 'signed-out', appId: APP }, result: { id: OP, kind: 'link-app', outcome: 'failed', failure: { command: 'auth-status', exitCode: null } } })
  expect(labels(shown)).toEqual([copy['action.signIn']])
  expect(shown.failure).toEqual({ text: copy['failed.linkApp'], command: { command: 'auth-status', exitCode: null }, details: [undefined, undefined] })

  shown = b.show({ account: { state: 'unconfigured' }, result: { id: OP, kind: 'link-app', outcome: 'cancelled' } })
  expect(shown.failure).toBeUndefined()
})

it.each(['sign-in', 'sign-out', 'check'] as const)('keeps the generic guidance for a failed %s', (kind) => {
  const shown = fixture().show({ account: { state: 'signed-out', appId: APP }, result: { id: OP, kind, outcome: 'failed' } })
  expect(shown.failure?.text).toBe(zh.failed)
})

it('explains a stopped Host component and reopens the stream', () => {
  const b = fixture()
  const shown = b.show(undefined, { linked: false, stopped: true })
  expect(shown).toMatchObject({ phase: 'stopped', detail: zh['detail.stopped'] })
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.retry).toHaveBeenCalledOnce()
})

it('shows who is signed in and asks before signing out', () => {
  const b = fixture()
  expect(b.show({ account: { state: 'connected', appId: APP, userName: '张三' } }).detail).toBe(text('detail.connectedAs', { name: '张三' }))
  const shown = b.show({ account: { state: 'connected', appId: APP } })
  expect(shown.detail).toBe(zh['detail.connected'])
  const signOut = action(shown, zh['action.signOut'])
  expect(signOut.confirm).toEqual({ title: zh['signOut.title'], body: zh['signOut.body'], label: zh['action.signOut'] })
  signOut.onClick()
  expect(b.actions.signOut).toHaveBeenCalledOnce()
})

it('shows the linked app and asks before changing it', () => {
  const b = fixture()
  const shown = b.show({ account: { state: 'signed-out', appId: APP } })
  expect(shown.notes?.map(note => note.text)).toEqual([text('app.linked', { id: 'cli_a' })])
  const replace = action(shown, zh['action.replaceApp'])
  expect(replace).toMatchObject({ variant: 'ghost', confirm: { title: zh['replaceApp.title'], body: zh['replaceApp.body'], label: zh['action.replaceApp'] } })
  replace.onClick()
  expect(b.actions.linkApp).toHaveBeenCalledOnce()
})

it.each<[string, FeishuState, keyof FeishuActions]>([
  ['links an app first', { account: { state: 'unconfigured' } }, 'linkApp'],
  ['signs in to a linked app', { account: { state: 'signed-out', appId: APP } }, 'signIn'],
])('answers the activation prompt with its next step: %s', (_name, state, step) => {
  const b = fixture()
  const primary = b.show(state).actions?.filter(item => item.variant === 'primary' && item.confirm === undefined)
  expect(primary?.map(item => item.onClick)).toEqual([b.actions[step]])
})
