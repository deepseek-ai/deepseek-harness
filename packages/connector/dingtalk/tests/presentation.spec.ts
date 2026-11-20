/**
 * The DingTalk section offers each state's next step, the signed-in user, a sign-out confirmation, and failure guidance,
 * in every shipped language.
 */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { ConnectorAccountDisplay, ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { afterAll, beforeAll, expect, it } from 'vitest'
import * as Dingtalk from '../src/index.ts'
import { en, zh, type DingtalkTextKey } from '../src/locales.ts'
import type { DingtalkState } from '../src/types.ts'
import { closeHost, createHost, type DingtalkHost, type DingtalkPage } from './harness.ts'

const OP = 'op' as ConnectorOperationId
const LINK = 'https://login.dingtalk.com/oauth2/auth'
const CHECK = { kind: 'start', operation: 'check' } as const
const SIGN_IN = { kind: 'start', operation: 'sign-in' } as const
const SIGN_OUT = { kind: 'start', operation: 'sign-out' } as const

/** The key's text as the Chinese and English browsers resolve it. */
const say = (key: DingtalkTextKey): Partial<Record<string, string>> => ({ zh: zh[key], en: en[key] })
const zhOf = (text: LocalizedText | undefined): string | undefined => typeof text === 'object' ? text.zh : text
const labels = (display: ConnectorAccountDisplay): (string | undefined)[] => display.buttons.map(button => zhOf(button.label))

let host: DingtalkHost
/** What the plugin registered for the Plugins page, with the failure details the CLI account Service adds. */
let page: DingtalkPage

beforeAll(async () => {
  host = await createHost()
  // `binDir` and `skillsDir` download nothing, so the release prefix is never requested.
  await host.ctx.plugin(Dingtalk, {
    binDir: host.binDir, skillsDir: host.skillsDir, releaseUrls: ['https://releases.invalid/download'], releaseTimeoutMs: 5_000,
  })
  page = host.pages[0]!
})

afterAll(() => closeHost(host))

const presentAccount = (view: DingtalkState): ConnectorAccountDisplay => page.present(view)

const SIGNED_OUT: DingtalkState = { account: { state: 'signed-out' } }
const CONNECTED: DingtalkState = { account: { state: 'connected', userName: '测试用户', corpName: '测试组织' } }

it('shows the dws download with its cancel, then offers the next step while signing in', () => {
  let shown = presentAccount({ account: { state: 'unchecked' }, operation: { id: OP, kind: 'check', phase: 'downloading', cancellable: true } })
  expect(shown).toMatchObject({ phase: 'checking', status: say('step.downloading') })
  expect(shown.buttons.map(button => button.command)).toEqual([{ kind: 'cancel' }])
  shown = presentAccount({ account: { state: 'unchecked' }, operation: { id: OP, kind: 'check', phase: 'checking', cancellable: false } })
  expect(shown).toMatchObject({ phase: 'checking', status: say('status.checking'), buttons: [] })
  expect(presentAccount({ account: { state: 'unchecked' } })).toMatchObject({ phase: 'checking', status: say('status.checking'), buttons: [] })

  shown = presentAccount(SIGNED_OUT)
  expect(shown).toMatchObject({
    phase: 'disconnected', status: say('status.disconnected'), badge: say('badge.disconnected'),
    detail: say('detail.disconnected'), connect: SIGN_IN, notes: [],
  })
  expect(shown.buttons).toMatchObject([{ label: say('action.connect'), command: SIGN_IN, variant: 'primary' }])

  shown = presentAccount({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true } })
  expect(shown).toMatchObject({ phase: 'connecting', status: say('step.authorizing'), badge: say('badge.connecting') })
  expect(labels(shown)).toEqual([zh['action.cancel']])
  shown = presentAccount({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true, authorizationUrl: LINK } })
  expect(shown.detail).toMatchObject(say('detail.authorizing'))
  expect(shown.buttons.map(button => button.command)).toEqual([{ kind: 'open' }, { kind: 'cancel' }])

  shown = presentAccount({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'checking', cancellable: false } })
  expect(shown).toMatchObject({ status: say('step.connecting'), buttons: [] })
})

it.each<[string, DingtalkState['account'], string]>([
  ['the user and organization', CONNECTED.account, zh['detail.connectedIn'].replace('{name}', '测试用户').replace('{org}', '测试组织')],
  ['the user', { state: 'connected', userName: '测试用户' }, zh['detail.connectedAs'].replace('{name}', '测试用户')],
  ['no name', { state: 'connected' }, zh['detail.connected']],
])('names %s that dws reports', (_name, account, detail) => {
  expect(zhOf(presentAccount({ account }).detail)).toBe(detail)
})

it('offers another sign-in while connected and asks before signing out', () => {
  let shown = presentAccount(CONNECTED)
  expect(shown).toMatchObject({ phase: 'connected', status: say('status.connected'), badge: say('badge.connected') })
  expect(shown.buttons).toMatchObject([
    { label: say('action.addAccount'), command: SIGN_IN },
    {
      label: say('action.signOut'), command: SIGN_OUT,
      confirm: { title: say('signOut.title'), body: say('signOut.body'), label: say('action.signOut') },
    },
  ])
  expect(shown.buttons[0]).not.toHaveProperty('confirm')
  shown = presentAccount({ ...CONNECTED, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', cancellable: false } })
  expect(shown).toMatchObject({ status: say('step.signing-out'), buttons: [] })
})

it('reports a failed sign-in with the CLI access hint and its diagnostic items, and no failure for a cancelled one', () => {
  const shown = presentAccount({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 2 } } })
  expect(shown.failure).toMatchObject({ text: say('failed.signIn'), details: ['auth-login', 'exit 2'] })
  expect(labels(shown)).toEqual([zh['action.connect']])
  expect(presentAccount({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } }).failure).toBeUndefined()
})

it.each<[string, DingtalkState, DingtalkTextKey]>([
  ['a sign-in dws cannot judge', { account: { state: 'unverified' } }, 'detail.unavailable'],
  ['a dws download that did not finish', { account: { state: 'not-installed' }, result: { id: OP, kind: 'check', outcome: 'failed' } }, 'detail.missing'],
  ['an unreadable account', { account: { state: 'unchecked' }, result: { id: OP, kind: 'check', outcome: 'failed' } }, 'detail.unavailable'],
])('retries %s by checking again', (_name, view, detail) => {
  const shown = presentAccount(view)
  expect(shown).toMatchObject({ phase: 'unavailable', status: say('status.unavailable'), badge: say('badge.unavailable'), detail: say(detail) })
  expect(shown.buttons).toMatchObject([{ label: say('action.retry'), command: CHECK }])
})

it('reports a failed check with the generic guidance and a failed sign-out without diagnostic items', () => {
  const shown = presentAccount({ account: { state: 'unchecked' }, result: { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } } })
  expect(shown.failure).toMatchObject({ text: say('failed'), details: ['auth-status', 'exit 1'] })
  const signOut = presentAccount({ ...CONNECTED, result: { id: OP, kind: 'sign-out', outcome: 'failed' } })
  expect(signOut.failure).toMatchObject({ text: say('failed') })
  expect(signOut.failure).not.toHaveProperty('details')
})

it('names the section, its activation prompt, and the notices of signing in and out', () => {
  expect(page.copy).toMatchObject({
    title: say('section.title'), hint: say('hint'),
    activation: { title: say('activation.title'), body: say('activation.body'), connect: say('action.connect') },
  })
  expect(page.operations).toMatchObject([
    { kind: 'check' }, { kind: 'sign-in', notice: say('notice.connected') }, { kind: 'sign-out', notice: say('notice.signed-out') },
  ])
  expect(page.operations[0]).not.toHaveProperty('notice')
})
