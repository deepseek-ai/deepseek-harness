/** The WeCom section offers each state's next step, the guide download rows, and failure guidance. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { CliAccountAction, CliAccountDisplay } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import { expect, it, vi } from 'vitest'
import { presentAccount, type WecomActions } from '../src/client/account.ts'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { en, zh } from '../src/client/locales.ts'

const OP = 'op' as CliOperationId
const QR = 'https://work.weixin.qq.com/qr'

function fixture(copy: typeof zh = zh) {
  const actions: WecomActions = {
    start: vi.fn(), cancel: vi.fn(), openAuthorization: vi.fn(), retry: vi.fn(), check: vi.fn(), connect: vi.fn(),
  }
  const show = (view: WecomState | undefined, page: Partial<ConnectionSnapshot> = {}): CliAccountDisplay =>
    presentAccount({ view, linked: true, stopped: false, busy: false, notice: undefined, ...page }, makeTranslate(copy), actions)
  return { actions, show }
}

const labels = (display: CliAccountDisplay): string[] => (display.actions ?? []).map(action => action.label)
const action = (display: CliAccountDisplay, label: string): CliAccountAction => {
  const found = [...display.actions ?? [], ...(display.notes ?? []).flatMap(note => note.action ?? [])].find(item => item.label === label)
  if (found === undefined) throw new Error(`no ${label} action`)
  return found
}

it('offers the next step for each state', () => {
  const b = fixture()
  let shown = b.show({ account: { state: 'unauthorized', skills: 'installed' } })
  expect(shown).toMatchObject({ phase: 'disconnected', detail: zh['detail.disconnected'], notes: [] })
  action(shown, zh['action.connect']).onClick()
  expect(b.actions.connect).toHaveBeenCalledOnce()

  shown = b.show({ account: { state: 'unauthorized', skills: 'installed' }, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: true } })
  expect(shown.status).toBe(zh['step.authorizing'])
  expect(labels(shown)).toEqual([zh['action.cancel']])
  shown = b.show({ account: { state: 'unauthorized', skills: 'installed' }, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: true, authorizationUrl: QR } })
  expect(shown.detail).toBe(zh['detail.authorizing'])
  action(shown, zh['action.open']).onClick()
  action(shown, zh['action.cancel']).onClick()
  expect(b.actions.openAuthorization).toHaveBeenCalledOnce()
  expect(b.actions.cancel).toHaveBeenCalledOnce()

  shown = b.show({ account: { state: 'unauthorized', skills: 'installed' }, operation: { id: OP, kind: 'connect', phase: 'checking', cancellable: false } })
  expect(shown).toMatchObject({ status: zh['step.connecting'], actions: [] })

  shown = b.show({ account: { state: 'authorized', skills: 'installed' } })
  expect(shown).toMatchObject({ phase: 'connected', detail: zh['detail.connected'], actions: [] })

  shown = b.show(undefined)
  expect(shown).toMatchObject({ phase: 'checking', actions: [], notes: [] })
})

it.each([['zh', zh], ['en', en]] as const)('reports a failed connection with its command in %s', (_locale, copy) => {
  const b = fixture(copy)
  let shown = b.show({ account: { state: 'unauthorized', skills: 'installed' }, result: { id: OP, kind: 'connect', outcome: 'failed', failure: { command: 'auth-init', exitCode: 2 } } })
  expect(shown.failure).toEqual({ text: copy.failed, command: { command: 'auth-init', exitCode: 2 } })
  expect(labels(shown)).toEqual([copy['action.connect']])

  shown = b.show({ account: { state: 'unauthorized', skills: 'installed' }, result: { id: OP, kind: 'connect', outcome: 'cancelled' } })
  expect(shown.failure).toBeUndefined()
})

it('retries an unreadable authorization by checking again', () => {
  const b = fixture()
  const shown = b.show({ account: { state: 'unchecked', skills: 'installed' }, result: { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } } })
  expect(shown.detail).toBe(zh['detail.unavailable'])
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.check).toHaveBeenCalledOnce()
})

it('reports guides that are downloading, and retries a failed download by checking again', () => {
  const b = fixture()
  expect(b.show({ account: { state: 'authorized', skills: 'downloading' } }).notes).toEqual([{ text: zh['skills.downloading'] }])
  const shown = b.show({ account: { state: 'authorized', skills: 'failed' } })
  expect(shown.notes?.map(note => note.text)).toEqual([zh['skills.failed']])
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.check).toHaveBeenCalledOnce()
  expect(b.show({ account: { state: 'authorized', skills: 'installed' } }).notes).toEqual([])
})

it('explains a stopped Host component and reopens the stream', () => {
  const b = fixture()
  const shown = b.show(undefined, { linked: false, stopped: true })
  expect(shown).toMatchObject({ phase: 'stopped', detail: zh['detail.stopped'] })
  action(shown, zh['action.retry']).onClick()
  expect(b.actions.retry).toHaveBeenCalledOnce()
})

it('answers the activation prompt by connecting', () => {
  const b = fixture()
  const primary = b.show({ account: { state: 'unauthorized', skills: 'installed' } }).actions?.filter(item => item.variant === 'primary' && item.confirm === undefined)
  expect(primary?.map(item => item.onClick)).toEqual([b.actions.connect])
})
