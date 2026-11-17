/** The WeCom section offers each state's next step, the guide download rows, and failure guidance, in every shipped language. */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { ConnectorAccountDisplay, ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'vitest'
import * as Wecom from '../src/index.ts'
import { en, zh, type WecomTextKey } from '../src/locales.ts'
import type { WecomState } from '../src/types.ts'
import { createHost, type WecomHost, type WecomPage } from './harness.ts'

const OP = 'op' as ConnectorOperationId
const QR = 'https://work.weixin.qq.com/qr'
const CHECK = { kind: 'start', operation: 'check' } as const
const CONNECT = { kind: 'start', operation: 'connect' } as const

/** The key's text as the Chinese and English browsers resolve it. */
const say = (key: WecomTextKey): Partial<Record<string, string>> => ({ zh: zh[key], en: en[key] })
const zhOf = (text: LocalizedText | undefined): string | undefined => typeof text === 'object' ? text.zh : text
const labels = (display: ConnectorAccountDisplay): (string | undefined)[] => display.buttons.map(button => zhOf(button.label))

let host: WecomHost
/** What the plugin registered for the Plugins page, with the failure details the CLI account Service adds. */
let page: WecomPage

beforeAll(async () => {
  host = await createHost()
  await host.ctx.plugin(Wecom, { binDir: host.binDir, skillsDir: host.skillsDir })
  page = host.pages[0]!
})

afterAll(async () => {
  await host.ctx.fiber.dispose()
  await rm(host.binDir, { recursive: true, force: true })
  await rm(host.skillsDir, { recursive: true, force: true })
})

const presentAccount = (view: WecomState): ConnectorAccountDisplay => page.present(view)

const unauthorized = { state: 'unauthorized', skills: 'installed' } as const

it('offers the next step for each state', () => {
  let shown = presentAccount({ account: unauthorized })
  expect(shown).toMatchObject({
    phase: 'disconnected', status: say('status.disconnected'), badge: say('badge.disconnected'),
    detail: say('detail.disconnected'), connect: CONNECT, notes: [],
  })
  expect(shown.buttons).toMatchObject([{ label: say('action.connect'), command: CONNECT, variant: 'primary' }])

  shown = presentAccount({ account: unauthorized, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: true } })
  expect(shown).toMatchObject({ phase: 'connecting', status: say('step.authorizing'), badge: say('badge.connecting') })
  expect(shown.detail).toBeUndefined()
  expect(shown.buttons).toMatchObject([{ label: say('action.cancel'), command: { kind: 'cancel' }, variant: 'ghost' }])

  shown = presentAccount({
    account: unauthorized, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: true, authorizationUrl: QR },
  })
  expect(shown.detail).toMatchObject(say('detail.authorizing'))
  expect(shown.buttons.map(button => button.command)).toEqual([{ kind: 'open' }, { kind: 'cancel' }])
  expect(labels(shown)).toEqual([zh['action.open'], zh['action.cancel']])

  shown = presentAccount({ account: unauthorized, operation: { id: OP, kind: 'connect', phase: 'checking', cancellable: false } })
  expect(shown).toMatchObject({ status: say('step.connecting'), buttons: [] })

  shown = presentAccount({ account: { state: 'authorized', botId: 'bot-1', skills: 'installed' } })
  expect(shown).toMatchObject({ phase: 'connected', status: say('status.connected'), badge: say('badge.connected'), detail: say('detail.connected') })
  expect(shown.buttons).toMatchObject([{
    label: say('action.rebind'), command: CONNECT,
    confirm: { title: say('rebind.title'), body: say('rebind.body'), label: say('action.rebind') },
  }])
  expect(shown.notes).toMatchObject([{ text: { zh: '已绑定机器人：bot-1', en: 'Bound bot: bot-1' } }])
  expect(presentAccount({ account: { state: 'authorized', skills: 'installed' } }).notes).toEqual([])

  for (const view of [
    { account: { state: 'authorized', skills: 'installed' }, operation: { id: OP, kind: 'check', phase: 'checking', cancellable: false } },
    { account: { state: 'unchecked', skills: 'installed' } },
  ] as const satisfies readonly WecomState[]) {
    shown = presentAccount(view)
    expect(shown).toMatchObject({ phase: 'checking', status: say('status.checking'), buttons: [] })
    expect(shown.badge).toBeUndefined()
  }
})

it('reports a failed connection with its diagnostic items, and no failure for a cancelled one', () => {
  let shown = presentAccount({ account: unauthorized, result: { id: OP, kind: 'connect', outcome: 'failed', failure: { command: 'auth-init', exitCode: 2 } } })
  expect(shown.failure).toMatchObject({ text: say('failed'), details: ['auth-init', 'exit 2'] })
  expect(labels(shown)).toEqual([zh['action.connect']])
  shown = presentAccount({ account: unauthorized, result: { id: OP, kind: 'connect', outcome: 'failed' } })
  expect(shown.failure).toMatchObject({ text: say('failed') })
  expect(shown.failure).not.toHaveProperty('details')
  shown = presentAccount({ account: { state: 'authorized', skills: 'installed' }, result: { id: OP, kind: 'connect', outcome: 'failed' } })
  expect(shown.failure).toBeDefined()
  expect(presentAccount({ account: unauthorized, result: { id: OP, kind: 'connect', outcome: 'cancelled' } }).failure).toBeUndefined()
})

it('retries an unreadable authorization by checking again', () => {
  const shown = presentAccount({
    account: { state: 'unchecked', skills: 'installed' }, result: { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } },
  })
  expect(shown).toMatchObject({ phase: 'unavailable', status: say('status.unavailable'), badge: say('badge.unavailable'), detail: say('detail.unavailable') })
  expect(shown.buttons).toMatchObject([{ label: say('action.retry'), command: CHECK }])
  expect(shown.failure?.details).toEqual(['auth-status', 'exit 1'])
})

it('reports guides that are downloading, and retries a failed download by checking again', () => {
  expect(presentAccount({ account: { state: 'authorized', skills: 'downloading' } }).notes).toMatchObject([{ text: say('skills.downloading') }])
  const [note] = presentAccount({ account: { state: 'authorized', skills: 'failed' } }).notes
  expect(note).toMatchObject({ text: say('skills.failed'), button: { label: say('action.retry'), command: CHECK } })
})

it('names the section, its activation prompt, and the notice a connection reports', () => {
  expect(page.copy).toMatchObject({
    title: say('section.title'), hint: say('hint'),
    activation: { title: say('activation.title'), body: say('activation.body'), connect: say('action.connect') },
  })
  expect(page.operations).toMatchObject([{ kind: 'check' }, { kind: 'connect', notice: say('notice.connected') }])
  expect(page.operations[0]).not.toHaveProperty('notice')
})
