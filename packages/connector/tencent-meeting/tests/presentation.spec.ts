/** The Tencent Meeting section offers each state's next step, the guide download row, and failure guidance, in every shipped language. */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { ConnectorAccountDisplay, ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'vitest'
import * as TencentMeeting from '../src/index.ts'
import { en, zh, type TencentMeetingTextKey } from '../src/locales.ts'
import type { TencentMeetingState } from '../src/types.ts'
import { createHost, type TencentMeetingHost, type TencentMeetingPage } from './harness.ts'

const OP = 'op' as ConnectorOperationId
const LINK = 'https://meeting.tencent.com/authorize'
const CHECK = { kind: 'start', operation: 'check' } as const
const SIGN_IN = { kind: 'start', operation: 'sign-in' } as const
const SIGN_OUT = { kind: 'start', operation: 'sign-out' } as const

/** The key's text as the Chinese and English browsers resolve it. */
const say = (key: TencentMeetingTextKey): Partial<Record<string, string>> => ({ zh: zh[key], en: en[key] })
const zhOf = (text: LocalizedText | undefined): string | undefined => typeof text === 'object' ? text.zh : text
const labels = (display: ConnectorAccountDisplay): (string | undefined)[] => display.buttons.map(button => zhOf(button.label))

let host: TencentMeetingHost
/** What the plugin registered for the Plugins page, with the failure details the CLI account Service adds. */
let page: TencentMeetingPage

beforeAll(async () => {
  host = await createHost()
  await host.ctx.plugin(TencentMeeting, { binDir: host.binDir, skillsDir: host.skillsDir })
  page = host.pages[0]!
})

afterAll(async () => {
  await host.ctx.fiber.dispose()
  await rm(host.binDir, { recursive: true, force: true })
  await rm(host.skillsDir, { recursive: true, force: true })
})

const presentAccount = (view: TencentMeetingState): ConnectorAccountDisplay => page.present(view)

const SIGNED_OUT: TencentMeetingState = { account: { state: 'signed-out', skills: 'installed' } }
const CONNECTED: TencentMeetingState = { account: { state: 'connected', userName: '测试用户', skills: 'installed' } }

it('offers the next step while signing in', () => {
  let shown = presentAccount(SIGNED_OUT)
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

  for (const view of [
    { ...SIGNED_OUT, operation: { id: OP, kind: 'check', phase: 'checking', cancellable: false } },
    { account: { state: 'unchecked', skills: 'installed' } },
  ] as const satisfies readonly TencentMeetingState[]) {
    shown = presentAccount(view)
    expect(shown).toMatchObject({ phase: 'checking', status: say('status.checking'), buttons: [] })
    expect(shown.badge).toBeUndefined()
  }
})

it('names the signed-in user and asks before signing out', () => {
  let shown = presentAccount(CONNECTED)
  expect(shown).toMatchObject({ phase: 'connected', status: say('status.connected'), badge: say('badge.connected') })
  expect(zhOf(shown.detail)).toBe(zh['detail.connected'].replace('{name}', '测试用户'))
  expect(shown.buttons).toMatchObject([{
    label: say('action.signOut'), command: SIGN_OUT,
    confirm: { title: say('signOut.title'), body: say('signOut.body'), label: say('action.signOut') },
  }])

  shown = presentAccount({ ...CONNECTED, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', cancellable: false } })
  expect(shown).toMatchObject({ status: say('step.signing-out'), buttons: [] })
  expect(shown.detail).toBeUndefined()
})

it('reports a failed sign-in with its diagnostic items, and no failure for a cancelled one', () => {
  let shown = presentAccount({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 1 } } })
  expect(shown.failure).toMatchObject({ text: say('failed'), details: ['auth-login', 'exit 1'] })
  expect(labels(shown)).toEqual([zh['action.connect']])
  shown = presentAccount({ ...CONNECTED, result: { id: OP, kind: 'sign-out', outcome: 'failed' } })
  expect(shown.failure).toMatchObject({ text: say('failed') })
  expect(shown.failure).not.toHaveProperty('details')
  expect(presentAccount({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } }).failure).toBeUndefined()
})

it('retries an unconfirmed or unreadable sign-in by checking again', () => {
  for (const view of [
    { account: { state: 'unverified', skills: 'installed' } },
    { account: { state: 'unchecked', skills: 'installed' }, result: { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 2 } } },
  ] as const satisfies readonly TencentMeetingState[]) {
    const shown = presentAccount(view)
    expect(shown).toMatchObject({ phase: 'unavailable', status: say('status.unavailable'), badge: say('badge.unavailable'), detail: say('detail.unavailable') })
    expect(shown.buttons).toMatchObject([{ label: say('action.retry'), command: CHECK }])
  }
})

it('reports a guide that is downloading, and retries a failed download by checking again', () => {
  expect(presentAccount({ account: { state: 'signed-out', skills: 'downloading' } }).notes).toMatchObject([{ text: say('skills.downloading') }])
  const [note] = presentAccount({ account: { state: 'signed-out', skills: 'failed' } }).notes
  expect(note).toMatchObject({ text: say('skills.failed'), button: { label: say('action.retry'), command: CHECK } })
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
