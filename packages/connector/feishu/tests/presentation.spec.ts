/** The Feishu section offers each state's next step, the linked app, confirmations, and failure guidance, in every shipped language. */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { ConnectorAccountDisplay, ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'vitest'
import * as Feishu from '../src/index.ts'
import { en, zh, type FeishuTextKey } from '../src/locales.ts'
import type { FeishuAppId, FeishuState } from '../src/types.ts'
import { createHost, type FeishuHost, type FeishuPage } from './harness.ts'

const OP = 'op' as ConnectorOperationId
const APP = 'cli_a' as FeishuAppId
const LINK = 'https://x.feishu.cn'
const CHECK = { kind: 'start', operation: 'check' } as const
const LINK_APP = { kind: 'start', operation: 'link-app' } as const
const SIGN_IN = { kind: 'start', operation: 'sign-in' } as const
const SIGN_OUT = { kind: 'start', operation: 'sign-out' } as const

/** The key's text as the Chinese and English browsers resolve it. */
const say = (key: FeishuTextKey): Partial<Record<string, string>> => ({ zh: zh[key], en: en[key] })
const zhOf = (text: LocalizedText | undefined): string | undefined => typeof text === 'object' ? text.zh : text
const labels = (display: ConnectorAccountDisplay): (string | undefined)[] => display.buttons.map(button => zhOf(button.label))

let host: FeishuHost
/** What the plugin registered for the Plugins page, with the failure details the CLI account Service adds. */
let page: FeishuPage

beforeAll(async () => {
  host = await createHost()
  await host.ctx.plugin(Feishu, { binDir: host.binDir })
  page = host.pages[0]!
})

afterAll(async () => {
  await host.ctx.fiber.dispose()
  await rm(host.binDir, { recursive: true, force: true })
})

const presentAccount = (view: FeishuState): ConnectorAccountDisplay => page.present(view)

const UNCONFIGURED: FeishuState = { account: { state: 'unconfigured' } }
const SIGNED_OUT: FeishuState = { account: { state: 'signed-out', appId: APP } }

it('links an app first, then signs in, with each step\'s page, guidance, and cancel', () => {
  let shown = presentAccount(UNCONFIGURED)
  expect(shown).toMatchObject({
    phase: 'disconnected', status: say('status.disconnected'), badge: say('badge.disconnected'),
    detail: say('detail.no-app'), connect: LINK_APP, notes: [],
  })
  expect(shown.buttons).toMatchObject([{ label: say('action.linkApp'), command: LINK_APP, variant: 'primary' }])

  shown = presentAccount({ ...UNCONFIGURED, operation: { id: OP, kind: 'link-app', phase: 'configuring', cancellable: true } })
  expect(shown).toMatchObject({ phase: 'connecting', status: say('step.configuring'), badge: say('badge.connecting') })
  expect(labels(shown)).toEqual([zh['action.cancel']])
  expect(shown.detail).toBeUndefined()
  shown = presentAccount({ ...UNCONFIGURED, operation: { id: OP, kind: 'link-app', phase: 'configuring', cancellable: true, authorizationUrl: LINK } })
  expect(shown.detail).toMatchObject(say('detail.configuring'))

  shown = presentAccount(SIGNED_OUT)
  expect(shown).toMatchObject({ phase: 'disconnected', detail: say('detail.signed-out'), connect: SIGN_IN })
  expect(shown.buttons).toMatchObject([{ label: say('action.signIn'), command: SIGN_IN, variant: 'primary' }])

  shown = presentAccount({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true, authorizationUrl: LINK } })
  expect(shown).toMatchObject({ status: say('step.authorizing'), detail: say('detail.authorizing') })
  expect(shown.buttons.map(button => button.command)).toEqual([{ kind: 'open' }, { kind: 'cancel' }])

  for (const [phase, status] of [['verifying', 'step.connecting'], ['checking', 'step.connecting'], ['cancelling', 'step.connecting']] as const) {
    shown = presentAccount({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase, cancellable: false } })
    expect(shown).toMatchObject({ status: say(status), buttons: [] })
  }

  shown = presentAccount({ ...SIGNED_OUT, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', cancellable: false, authorizationUrl: LINK } })
  expect(shown).toMatchObject({ status: say('step.signing-out') })
  expect(shown.detail).toBeUndefined()
  expect(labels(shown)).toEqual([zh['action.open']])
  shown = presentAccount({ ...SIGNED_OUT, operation: { id: OP, kind: 'link-app', phase: 'signing-out', cancellable: false } })
  expect(shown).toMatchObject({ status: say('step.signing-out') })

  for (const view of [
    { ...SIGNED_OUT, operation: { id: OP, kind: 'check', phase: 'checking', cancellable: false } },
    { account: { state: 'unchecked' } },
  ] as const satisfies readonly FeishuState[]) {
    shown = presentAccount(view)
    expect(shown).toMatchObject({ phase: 'checking', status: say('status.checking'), buttons: [], notes: [] })
    expect(shown.badge).toBeUndefined()
  }
})

it('retries an unconfirmed sign-in by checking again', () => {
  const shown = presentAccount({ account: { state: 'unverified', appId: APP } })
  expect(shown).toMatchObject({ phase: 'unavailable', status: say('status.unavailable'), badge: say('badge.unavailable'), detail: say('detail.unavailable') })
  expect(shown.buttons).toMatchObject([{ label: say('action.retry'), command: CHECK }])
})

it('retries a check that failed before the account was ever read', () => {
  const shown = presentAccount({
    account: { state: 'unchecked' },
    result: { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 3 } },
  })
  expect(shown).toMatchObject({
    phase: 'unavailable', status: say('status.unavailable'), badge: say('badge.unavailable'), detail: say('detail.unavailable'),
    notes: [], failure: { text: say('failed'), details: ['auth-status', 'exit 3'] },
  })
  expect(shown.buttons).toMatchObject([{ label: say('action.retry'), command: CHECK }])
})

it('shows the download of a missing CLI with its cancel, and a retry after one that did not finish', () => {
  const UNCHECKED: FeishuState = { account: { state: 'unchecked' } }
  let shown = presentAccount({ ...UNCHECKED, operation: { id: OP, kind: 'check', phase: 'downloading', cancellable: true } })
  expect(shown).toMatchObject({ phase: 'checking', status: say('step.downloading'), notes: [] })
  expect(shown.buttons).toMatchObject([{ label: say('action.cancel'), command: { kind: 'cancel' }, variant: 'ghost' }])
  expect(shown.badge).toBeUndefined()
  shown = presentAccount({ ...UNCHECKED, operation: { id: OP, kind: 'check', phase: 'cancelling', cancellable: false } })
  expect(shown).toMatchObject({ phase: 'checking', status: say('status.checking'), buttons: [] })
  shown = presentAccount({ ...UNCHECKED, operation: { id: OP, kind: 'link-app', phase: 'downloading', cancellable: true } })
  expect(shown).toMatchObject({ phase: 'connecting', status: say('step.downloading') })

  const MISSING: FeishuState = { account: { state: 'not-installed' } }
  shown = presentAccount({ ...MISSING, result: { id: OP, kind: 'check', outcome: 'failed' } })
  expect(shown).toMatchObject({
    phase: 'unavailable', status: say('status.unavailable'), badge: say('badge.unavailable'), detail: say('detail.missing'),
    notes: [], failure: { text: say('failed') },
  })
  expect(shown.buttons).toMatchObject([{ label: say('action.retry'), command: CHECK }])
  shown = presentAccount({ ...MISSING, result: { id: OP, kind: 'check', outcome: 'cancelled' } })
  expect(shown).toMatchObject({ phase: 'unavailable', detail: say('detail.missing') })
  expect(labels(shown)).toEqual([zh['action.retry']])
  expect(shown.failure).toBeUndefined()
})

it('reports app-link recovery with the command and exit code', () => {
  let shown = presentAccount({
    ...UNCONFIGURED,
    result: { id: OP, kind: 'link-app', outcome: 'failed', failure: { command: 'config-init', exitCode: 1 } },
  })
  expect(labels(shown)).toEqual([zh['action.linkApp']])
  expect(shown.failure).toMatchObject({ text: say('failed.linkApp'), details: ['config-init', 'exit 1'] })

  shown = presentAccount({ ...SIGNED_OUT, result: { id: OP, kind: 'link-app', outcome: 'failed', failure: { command: 'auth-status', exitCode: null } } })
  expect(labels(shown)).toEqual([zh['action.signIn']])
  expect(shown.failure).toMatchObject({ text: say('failed.linkApp'), details: ['auth-status'] })

  expect(presentAccount({ ...UNCONFIGURED, result: { id: OP, kind: 'link-app', outcome: 'cancelled' } }).failure).toBeUndefined()
})

it.each(['sign-in', 'sign-out', 'check'] as const)('keeps the generic guidance for a failed %s', (kind) => {
  const failure = presentAccount({ ...SIGNED_OUT, result: { id: OP, kind, outcome: 'failed' } }).failure
  expect(failure).toMatchObject({ text: say('failed') })
  expect(failure).not.toHaveProperty('details')
})

it('shows who is signed in and asks before signing out', () => {
  expect(zhOf(presentAccount({ account: { state: 'connected', appId: APP, userName: '张三' } }).detail)).toBe(zh['detail.connectedAs'].replace('{name}', '张三'))
  const shown = presentAccount({ account: { state: 'connected', appId: APP } })
  expect(shown).toMatchObject({ phase: 'connected', status: say('status.connected'), badge: say('badge.connected'), detail: say('detail.connected') })
  expect(shown.buttons).toMatchObject([{
    label: say('action.signOut'), command: SIGN_OUT,
    confirm: { title: say('signOut.title'), body: say('signOut.body'), label: say('action.signOut') },
  }])
})

it('shows the linked app and asks before changing it', () => {
  for (const view of [SIGNED_OUT, { account: { state: 'unverified', appId: APP } }, { account: { state: 'connected', appId: APP } }] as const satisfies readonly FeishuState[]) {
    const [note] = presentAccount(view).notes
    expect(zhOf(note?.text)).toBe(zh['app.linked'].replace('{id}', 'cli_a'))
    expect(note?.button).toMatchObject({
      label: say('action.replaceApp'), command: LINK_APP, variant: 'ghost',
      confirm: { title: say('replaceApp.title'), body: say('replaceApp.body'), label: say('action.replaceApp') },
    })
  }
})

it('names the section, its activation prompt, and the notice of each page operation', () => {
  expect(page.copy).toMatchObject({
    title: say('section.title'), hint: say('hint'),
    activation: { title: say('activation.title'), body: say('activation.body'), connect: say('action.connect') },
  })
  expect(page.operations).toMatchObject([
    { kind: 'check' },
    { kind: 'link-app', notice: say('notice.app-linked') },
    { kind: 'sign-in', notice: say('notice.connected') },
    { kind: 'sign-out', notice: say('notice.signed-out') },
  ])
  expect(page.operations[0]).not.toHaveProperty('notice')
})
