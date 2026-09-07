/** Client-face process fixture used by Host-side protocol integration tests. */

import { parentPort, workerData } from 'node:worker_threads'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebSocket from 'ws'
import { ClientInspectorSource } from '../../src/client/bridge/transport.ts'
import { ClientSourceCatalog } from '../../src/client/cdp/sources.ts'
import { publishCordisTree } from '../../src/client/inspection/cordis.ts'
import { inspectorId } from '../../src/shared/bridge/ids.ts'
import type { InspectorClientBootstrap } from '../../src/shared/bridge/messages/control.ts'
import type { InspectorJsonValue } from '../../src/shared/json.ts'
import { createInspectorService } from '../../src/shared/service.ts'

interface ClientFixtureInput {
  readonly bootstrap: InspectorClientBootstrap
  readonly label: string
  readonly sourceCatalog?: {
    readonly sourceText: string
    readonly sourceMap: string
    readonly sourceUrl: string
    readonly sourceMapUrl: string
  }
}

interface ClientFixtureRequest {
  readonly id: number
  readonly op:
    | 'add-fiber'
    | 'close'
    | 'disconnect'
    | 'get-tree'
    | 'log-cordis'
    | 'log-value'
    | 'publish'
    | 'refresh-tree'
    | 'remove-fiber'
    | 'set-global'
    | 'set-ingest-paused'
  readonly paused?: boolean
  readonly name?: string
  readonly value?: InspectorJsonValue
  readonly marker?: string
  readonly topic?: string
}

const port = parentPort
if (port === null) throw new Error('Inspector Client fixture requires a Worker parent port')
const input = workerData as ClientFixtureInput
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
console.log = () => {}

const context = new Context()
const childFiber = context.plugin({ name: 'client-child', apply() {} })
await childFiber.await()
Reflect.set(globalThis, '__cordisClientProbe', context)
Reflect.set(globalThis, '__cordisClientFiberProbe', childFiber)

const sourceCatalog = input.sourceCatalog === undefined
  ? undefined
  : new ClientSourceCatalog([{
    scriptKey: inspectorId<'RuntimeScriptKey'>('bundle', 'scriptKey'),
    url: input.sourceCatalog.sourceUrl,
    hash: 'test',
    sourceMapUrl: input.sourceCatalog.sourceMapUrl,
    isModule: false,
    loadSource: async () => input.sourceCatalog!.sourceText,
    loadSourceMap: async () => input.sourceCatalog!.sourceMap,
  }])
const source = new ClientInspectorSource(input.bootstrap, input.label, sourceCatalog)
const disposeCordis = publishCordisTree(context, source, {
  maxNodes: input.bootstrap.maxCordisNodes,
  maxBytes: input.bootstrap.maxFrameBytes - 4_096,
})
const service = createInspectorService(source)
let addedFiber: Fiber | undefined

port.on('message', (message: ClientFixtureRequest) => {
  void dispatch(message).then(
    (value) => {
      port.postMessage({ type: 'response', id: message.id, ok: true, value })
      if (message.op === 'close') port.close()
    },
    (error: unknown) => {
      port.postMessage({
        type: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  )
})
port.postMessage({ type: 'ready', fiberUid: childFiber.uid })

async function dispatch(message: ClientFixtureRequest): Promise<unknown> {
  switch (message.op) {
    case 'publish':
      source.publish(requiredString(message.topic, 'topic'), message.value ?? null)
      return undefined
    case 'set-global':
      Reflect.set(globalThis, requiredString(message.name, 'name'), message.value)
      return undefined
    case 'log-value':
      console.log(message.value, requiredString(message.marker, 'marker'))
      return undefined
    case 'log-cordis':
      console.log(context, childFiber, requiredString(message.marker, 'marker'))
      return undefined
    case 'get-tree':
      return await service.cordis.getTree()
    case 'set-ingest-paused': {
      const socket = Reflect.get(source, 'socket') as WebSocket | undefined
      if (socket === undefined) throw new Error('Inspector Client ingest socket is unavailable')
      if (message.paused) socket.pause()
      else socket.resume()
      return undefined
    }
    case 'disconnect': {
      const socket = Reflect.get(source, 'socket') as WebSocket | undefined
      socket?.terminate()
      return undefined
    }
    case 'refresh-tree':
      context.emit('internal/status', childFiber.ctx.fiber, childFiber.ctx.fiber.state)
      return undefined
    case 'add-fiber':
      addedFiber = context.plugin({ name: 'dynamic-client-child', apply() {} }).ctx.fiber
      await addedFiber.await()
      return addedFiber.uid
    case 'remove-fiber':
      await addedFiber?.dispose()
      addedFiber = undefined
      return undefined
    case 'close':
      await addedFiber?.dispose()
      disposeCordis()
      source.close()
      await context.fiber.dispose()
      return undefined
  }
}

function requiredString(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`Inspector Client fixture ${field} is required`)
  return value
}
