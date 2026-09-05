/** Host Worker port-selection behavior. */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startInspector, type InspectorHandle } from '../src/host/bridge/controller.ts'

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}

async function listen(server: Server, port: number): Promise<AddressInfo> {
  return await new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('test server did not bind a TCP port'))
        return
      }
      resolve(address)
    })
  })
}

async function bindWithAvailableSuccessor(): Promise<Server> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = createServer()
    const address = await listen(candidate, 0)
    if (address.port === 65_535) {
      await closeServer(candidate)
      continue
    }
    const probe = createServer()
    try {
      await listen(probe, address.port + 1)
      return candidate
    } catch {
      await closeServer(candidate)
    } finally {
      await closeServer(probe)
    }
  }
  throw new Error('test could not reserve an occupied port with a bindable successor')
}

describe('Inspector endpoint port selection', () => {
  let blocker: Server | undefined
  let inspector: InspectorHandle | undefined

  afterEach(async () => {
    await inspector?.close()
    inspector = undefined
    if (blocker !== undefined) await closeServer(blocker)
    blocker = undefined
  })

  it('advances from an occupied starting port and publishes the selected port', async () => {
    blocker = await bindWithAvailableSuccessor()
    const occupiedAddress = blocker.address()
    if (occupiedAddress === null || typeof occupiedAddress === 'string') {
      throw new Error('test server did not bind a TCP port')
    }

    inspector = await startInspector({ port: occupiedAddress.port, captureFetch: false })
    const selectedPort = Number(new URL(inspector.endpoint.httpUrl).port)

    expect(selectedPort).toBeGreaterThan(occupiedAddress.port)
    expect(new URL(inspector.endpoint.webSocketDebuggerUrl).port).toBe(String(selectedPort))
    expect(new URL(inspector.endpoint.client.endpoint).port).toBe(String(selectedPort))
    await expect(fetch(new URL('json', inspector.endpoint.httpUrl)).then(response => response.status)).resolves.toBe(200)
  })
})
