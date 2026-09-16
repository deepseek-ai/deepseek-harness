/** A window hold accepts each physical acknowledgement and releases pending consumers. */
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteStream, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalRemote } from '../src/client/model.ts'
import { TerminalWindowHold } from '../src/client/retention.ts'
import type { TerminalRetentionFrame, WebTerminalId } from '../src/types.ts'

const holds: TerminalWindowHold[] = []
afterEach(async () => { await Promise.all(holds.splice(0).map(hold => hold.dispose())) })
function hold(retain: TerminalRemote['retain']) {
  const gateway: Pick<ClientRemote, '$stream'> = { $stream: options => new RemoteStream({ generation: createSnapshotStore(undefined) }, options) }
  const held = new TerminalWindowHold(gateway, { retain } as TerminalRemote, 'session' as SessionId, 'terminal' as WebTerminalId)
  holds.push(held)
  return held
}

it('fails pending and later attachments when the Host ends an acknowledged hold', async () => {
  const finish = Promise.withResolvers<undefined>()
  const held = hold(async function* () { yield { type: 'retained' }; await finish.promise })
  await held.ready(new AbortController().signal)
  finish.resolve(undefined)
  await expect.poll(() => held.failed).toBe(true)
  await expect(held.ready(new AbortController().signal)).rejects.toThrow('hold ended')
})

it('cancels an acknowledgement waiter independently of another view of the same terminal', async () => {
  const ack = Promise.withResolvers<undefined>()
  const held = hold(async function* (_session, _id, signal) {
    await ack.promise
    yield { type: 'retained' }
    await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
  })
  const cancel = new AbortController()
  const first = held.ready(cancel.signal)
  const rejected = expect(first).rejects.toThrow('view removed')
  const second = held.ready(new AbortController().signal)
  cancel.abort(new Error('view removed'))
  await rejected
  ack.resolve(undefined)
  await second
  expect(held.failed).toBe(false)
})

it('preserves a non-Error transport failure as the cause of the failed hold', async () => {
  const gateway = { $stream: () => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<never> {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exercise an untyped carrier failure.
      await Promise.reject('non-error transport failure')
    },
    dispose: async () => {},
  } as unknown as RemoteStream<TerminalRetentionFrame>) } as Pick<ClientRemote, '$stream'>
  const held = new TerminalWindowHold(gateway, { retain: vi.fn() } as unknown as TerminalRemote, 'session' as SessionId, 'terminal' as WebTerminalId)
  holds.push(held)
  await expect.poll(() => held.failed).toBe(true)
  await expect(held.ready(new AbortController().signal)).rejects.toMatchObject({ cause: 'non-error transport failure' })
})
