/** The WeCom section offers each state's next step, the guide download rows, and failure guidance, in every shipped language. */
import type { CliAccountDisplay, CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { expect, it } from 'vitest'
import { en, zh, type WecomTextKey } from '../src/locales.ts'
import { COPY, OPERATIONS, presentAccount } from '../src/presentation.ts'
import type { WecomState } from '../src/types.ts'

const OP = 'op' as CliOperationId
const QR = 'https://work.weixin.qq.com/qr'
const CHECK = { kind: 'start', operation: 'check' } as const
const CONNECT = { kind: 'start', operation: 'connect' } as const

/** The key's text as the Chinese and English browsers resolve it. */
const say = (key: WecomTextKey): Partial<Record<string, string>> => ({ zh: zh[key], en: en[key] })
const zhOf = (text: LocalizedText | undefined): string | undefined => typeof text === 'object' ? text.zh : text
const labels = (display: CliAccountDisplay): (string | undefined)[] => display.buttons.map(button => zhOf(button.label))

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

  shown = presentAccount({ account: { state: 'authorized', skills: 'installed' } })
  expect(shown).toMatchObject({ phase: 'connected', status: say('status.connected'), badge: say('badge.connected'), detail: say('detail.connected'), buttons: [] })

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
  expect(COPY).toMatchObject({
    title: say('section.title'), hint: say('hint'),
    activation: { title: say('activation.title'), body: say('activation.body'), connect: say('action.connect') },
  })
  expect(OPERATIONS).toMatchObject([{ kind: 'check' }, { kind: 'connect', notice: say('notice.connected') }])
  expect(OPERATIONS[0]).not.toHaveProperty('notice')
})
