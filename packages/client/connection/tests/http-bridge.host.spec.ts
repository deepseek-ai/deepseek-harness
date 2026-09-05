import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { bridge } from '../src/http-bridge.ts'

describe('HTTP bridge abort', () => {
  it('destroys a declared-oversize request instead of draining it', async () => {
    const destroyed: true[] = []
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.prompt',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      destroy: () => { destroyed.push(true) },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      requestBodyMode: () => 'buffered',
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, 1000)
    // The socket must not stay parked draining a body the client can trickle
    // at will after the rejection — same discipline as the chunked overrun.
    expect(status).toBe(413)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(destroyed).toHaveLength(1)
  })

  it('aborts a pending native picker request when the browser disconnects', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'picker-1', method: 'directoryPicker/pick', payload: { args: {} },
    })
    const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/directoryPicker/pick',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { return true },
      end() { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let carrierSignal: AbortSignal | undefined
    const pending = bridge(request, response, {
      requestBodyMode: () => 'buffered',
      fetch: async (input) => {
        const fetchRequest = input
        carrierSignal = fetchRequest.signal
        resolveStarted()
        if (!fetchRequest.signal.aborted) {
          await new Promise<void>((resolve) => {
            fetchRequest.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        return Response.json({ aborted: fetchRequest.signal.aborted })
      },
    }, Number.MAX_SAFE_INTEGER)
    await started
    response.emit('close')
    await pending
    expect(carrierSignal?.aborted).toBe(true)
  })

  it('streams a declared 2.19 GiB request before the body ends and bypasses the JSON buffer cap', async () => {
    const request = new Readable({ read() {} }) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session/uploadFileBinary?sessionId=s1',
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(Math.ceil(2.19 * 1024 ** 3)),
      },
    })
    let status: number | undefined
    const responseBytes: Uint8Array[] = []
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number) { status = code; return this },
      write(chunk: Uint8Array) { responseBytes.push(chunk); return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    const received: Uint8Array[] = []
    const pending = bridge(request, response, {
      requestBodyMode: () => 'streaming',
      fetch: async (input) => {
        resolveStarted()
        if (input.body === null) throw new Error('streaming request lost its body')
        for await (const chunk of input.body) received.push(chunk)
        return new Response('stored')
      },
    }, 1)

    await started
    expect(received).toEqual([])
    request.push(Buffer.from([1, 2]))
    request.push(Buffer.from([3, 4]))
    request.push(null)
    await pending
    expect(status).toBe(200)
    expect(received).toEqual([Uint8Array.of(1, 2), Uint8Array.of(3, 4)])
    expect(Buffer.concat(responseBytes).toString()).toBe('stored')
  })

  it('closes an unread streaming request after returning an early validation response', async () => {
    const destroyed: true[] = []
    const request = new Readable({ read() {} }) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session/uploadFileBinary',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      destroy: () => { destroyed.push(true) },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      requestBodyMode: () => 'streaming',
      fetch: () => Promise.resolve(new Response(null, { status: 415 })),
    }, 1)
    expect(status).toBe(415)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(destroyed).toEqual([true])
  })
})
