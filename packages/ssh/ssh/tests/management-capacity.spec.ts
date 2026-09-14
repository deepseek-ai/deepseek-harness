/** Independent request capacities keep helper health and cleanup available under ordinary load. */
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { SSH_MAX_PROCESS_HANDLES, SSH_MAX_TEXT_STREAMS, SshRpcPeer } from '../src/protocol.ts'

const frameBytes = 128 * 1024
const management = [
  { method: 'heartbeat', limit: 1 },
  { method: 'close', limit: 1 },
  { method: 'process.terminate', limit: SSH_MAX_PROCESS_HANDLES },
  { method: 'fs.streamClose', limit: SSH_MAX_TEXT_STREAMS },
] as const
const allClasses = [{ method: 'process.done', limit: 1 }, ...management]
const paramsSchema = z.object({ index: z.number(), immediate: z.boolean().optional() })

interface Admission {
  readonly method: string
  readonly signal: AbortSignal
  readonly aborted: Promise<undefined>
  release(): void
}

function setup(clientLimit = 1, serverLimit = 1, settleOnAbort = true) {
  const inbound = new PassThrough({ highWaterMark: frameBytes * 2 })
  const outbound = new PassThrough({ highWaterMark: frameBytes * 2 })
  const admissions = new Map<number, ReturnType<typeof Promise.withResolvers<Admission>>>()
  const entered: Admission[] = []
  const handlers: Promise<undefined>[] = []
  const requests: Promise<unknown>[] = []
  const serverClosed = Promise.withResolvers<Error>()
  let index = 0
  const server = new SshRpcPeer(outbound, inbound, frameBytes, serverLimit, async (method, raw, signal) => {
    const params = paramsSchema.parse(raw)
    if (params.immediate) return null
    const gate = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const entry: Admission = { method, signal, aborted: aborted.promise, release: () => { gate.resolve(undefined) } }
    handlers.push(gate.promise)
    signal.addEventListener('abort', () => {
      aborted.resolve(undefined)
      if (settleOnAbort) gate.resolve(undefined)
    }, { once: true })
    entered.push(entry)
    admissions.get(params.index)?.resolve(entry)
    await gate.promise
    return null
  })
  server.once('closed', (error: Error) => { serverClosed.resolve(error) })
  const client = new SshRpcPeer(inbound, outbound, frameBytes, clientLimit)
  const hold = (method: string, signal?: AbortSignal) => {
    const id = ++index
    const admitted = Promise.withResolvers<Admission>()
    admissions.set(id, admitted)
    const result = client.request(method, { index: id }, z.null(), signal)
    void result.catch(() => {})
    requests.push(result)
    return { result, admitted: admitted.promise }
  }
  const immediate = (method: string) => client.request(method, { index: ++index, immediate: true }, z.null())
  const extraFrame = (method: string) => {
    const id = ++index
    const admitted = Promise.withResolvers<Admission>()
    admissions.set(id, admitted)
    const body = Buffer.from(JSON.stringify({ type: 'request', id: `raw-overflow-${id}`, method, params: { index: id } }))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    outbound.write(Buffer.concat([header, body]))
    return admitted.promise
  }
  onTestFinished(async () => {
    client.close()
    server.close()
    for (const entry of entered) entry.release()
    await Promise.allSettled(requests)
    await Promise.all(handlers)
  })
  return { client, server, hold, immediate, extraFrame, entered, closed: serverClosed.promise }
}

describe('SSH management request capacity', () => {
  it.each(allClasses)('retains $method credit while a cancelled remote handler is still cleaning up', async ({ method, limit }) => {
    const peer = setup(1, 1, false)
    const controller = new AbortController()
    const held = Array.from({ length: limit }, (_, index) => peer.hold(method, index === 0 ? controller.signal : undefined))
    const entries = await Promise.all(held.map(call => call.admitted))
    const first = held[0]!
    const entry = entries[0]!
    const rejected = expect(first.result).rejects.toThrow('not rolled back')
    controller.abort()
    await rejected
    await entry.aborted
    await expect(peer.immediate(method)).rejects.toThrow('pending request limit reached')
    const independent = method === 'heartbeat' ? 'close' : 'heartbeat'
    await expect(peer.immediate(independent)).resolves.toBeNull()
    entry.release()
    await peer.immediate(independent)
    await expect(peer.immediate(method)).resolves.toBeNull()
    for (const admitted of entries) admitted.release()
    await Promise.allSettled(held.map(call => call.result))
  })

  it('keeps heartbeat and close available with one ordinary call and all cleanup handles outstanding', async () => {
    const peer = setup()
    const ordinary = peer.hold('process.done')
    const processes = Array.from({ length: SSH_MAX_PROCESS_HANDLES }, () => peer.hold('process.terminate'))
    const streams = Array.from({ length: SSH_MAX_TEXT_STREAMS }, () => peer.hold('fs.streamClose'))
    const held = [ordinary, ...processes, ...streams]
    const entries = await Promise.all(held.map(call => call.admitted))
    expect(entries).toHaveLength(1 + SSH_MAX_PROCESS_HANDLES + SSH_MAX_TEXT_STREAMS)
    await expect(peer.immediate('heartbeat')).resolves.toBeNull()
    await expect(peer.immediate('close')).resolves.toBeNull()
    for (const method of ['process.done', 'process.terminate', 'fs.streamClose']) {
      await expect(peer.immediate(method)).rejects.toThrow('pending request limit reached')
    }
    for (const entry of entries) entry.release()
    await expect(Promise.all(held.map(call => call.result))).resolves.toHaveLength(entries.length)
    await expect(peer.immediate('process.done')).resolves.toBeNull()
  })

  it.each(management.slice(0, 2))('admits only one pending $method without consuming ordinary capacity', async ({ method }) => {
    const peer = setup()
    const ordinary = peer.hold('process.done')
    const managementCall = peer.hold(method)
    const [ordinaryEntry, entry] = await Promise.all([ordinary.admitted, managementCall.admitted])
    await expect(peer.immediate(method)).rejects.toThrow('pending request limit reached')
    await expect(peer.immediate(method === 'heartbeat' ? 'close' : 'heartbeat')).resolves.toBeNull()
    entry.release()
    await managementCall.result
    await expect(peer.immediate(method)).resolves.toBeNull()
    ordinaryEntry.release()
    await ordinary.result
  })

  it.each(allClasses)('rejects receive-side overflow for $method at its own quota', async ({ method, limit }) => {
    // The ordinary sender has a larger allowance; raw frames also bypass fixed management sender limits.
    const peer = setup(2, 1)
    const held = Array.from({ length: limit }, () => peer.hold(method))
    await Promise.all(held.map(call => call.admitted))
    const extra = peer.extraFrame(method)
    const outcome = await Promise.race([
      peer.closed.then(error => ({ kind: 'closed' as const, error })),
      extra.then(() => ({ kind: 'admitted' as const })),
    ])
    expect(outcome.kind).toBe('closed')
    if (outcome.kind !== 'closed') throw new Error('receiver admitted a request above its own quota')
    expect(outcome.error.message).toContain('unexpected or excessive request')
    expect(peer.entered).toHaveLength(limit)
    expect(peer.entered.every(entry => entry.signal.aborted)).toBe(true)
    const results = await Promise.allSettled(held.map(call => call.result))
    expect(results.every(result => result.status === 'rejected')).toBe(true)
  })

  it.each(allClasses)('releases the $method quota after cancellation settles its handler', async ({ method, limit }) => {
    const peer = setup()
    const controller = new AbortController()
    const held = Array.from({ length: limit }, (_, index) => peer.hold(method, index === limit - 1 ? controller.signal : undefined))
    const entries = await Promise.all(held.map(call => call.admitted))
    const cancelled = held.at(-1)
    const entry = entries.at(-1)
    if (cancelled === undefined || entry === undefined) throw new Error('expected a held cancellation slot')
    const rejection = expect(cancelled.result).rejects.toThrow('not rolled back')
    controller.abort()
    await rejection
    await entry.aborted
    // A completed independent exchange follows the cancel frame and lets the aborted handler publish its reply.
    await peer.immediate(method === 'heartbeat' ? 'close' : 'heartbeat')
    const replacement = peer.hold(method)
    const replacementEntry = await replacement.admitted
    expect(replacementEntry.signal.aborted).toBe(false)
    expect(peer.entered).toHaveLength(limit + 1)
    for (const admitted of [...entries, replacementEntry]) admitted.release()
    await Promise.allSettled(held.map(call => call.result))
    await expect(replacement.result).resolves.toBeNull()
  })
})
