/** Deterministic Worker peer with an owned listener and drainable browser requests. */
import { parentPort, workerData } from 'node:worker_threads'
import { createServer } from 'node:net'
import { once } from 'node:events'

const server = createServer(socket => socket.end())
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const scenario = new URL(workerData.cdpEndpoint).hostname
let release
let active
parentPort.on('message', async ({ method, reply }) => {
  if (method === 'fixture-release') { release?.(); return }
  if (method === 'ready' && scenario === 'opening') return
  if (method === 'close' && scenario === 'closing') return
  if (method === 'tabs' && scenario === 'error') throw new Error('Fixture worker crashed')
  if (method === 'tabs' && scenario === 'crash') { process.exit(23); return }
  if (method === 'ready' && scenario === 'failure') {
    reply.postMessage({ ok: false, error: 'Extension initialization failed' })
  } else if (method === 'close' && scenario === 'close-failure') {
    reply.postMessage({ ok: false, error: 'Extension request did not drain' })
  } else {
    if (method === 'act') {
      active = new Promise(resolve => { release = resolve })
      parentPort.postMessage({ event: 'operation-started' })
      await active
    }
    if (method === 'close') {
      parentPort.postMessage({ event: 'close-started' })
      await active
      await new Promise(resolve => server.close(resolve))
    }
    reply.postMessage({ ok: true, value: { port: server.address()?.port, model: workerData.model, env: process.env } })
  }
  reply.close()
})
