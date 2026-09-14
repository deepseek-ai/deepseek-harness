/** Real helper and authenticated stream endpoints over an in-memory administrative transport. */
import { PassThrough } from 'node:stream'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { runSshHelper } from '../../src/helper.ts'
import { SshRpcPeer } from '../../src/protocol.ts'
import { helloSchema, type SshStreamEndpoint } from '../../src/schemas.ts'
import { authenticateStream } from '../../src/stream-security.ts'

export async function createHelperHarness(handshake = true, leaseMs = 30_000) {
  const root = await realpath(await mkdtemp('/tmp/dsh-ssh-rpc-'))
  const input = new PassThrough()
  const output = new PassThrough()
  const controller = new AbortController()
  const serving = runSshHelper({ input, output, entryPath: fileURLToPath(new URL('../../src/helper-entry.ts', import.meta.url)), signal: controller.signal })
  void serving.catch(() => {})
  const client = new SshRpcPeer(output, input, 64 * 1024 * 1024, 128)
  const sockets = new Set<Socket>()
  const hello = () => client.request('hello', { protocol: 1, workspace: root, leaseMs }, helloSchema)
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      for (const socket of [...sockets].reverse()) socket.destroy()
      client.close()
      controller.abort()
      try { await serving } finally { await rm(root, { recursive: true, force: true }) }
    })()
    return closing
  }
  const connectStream = async (endpoint: SshStreamEndpoint, signal?: AbortSignal) => {
    const raw = createConnection({ path: endpoint.path, allowHalfOpen: true, ...(signal === undefined ? {} : { signal }) })
    sockets.add(raw)
    raw.once('close', () => { sockets.delete(raw) })
    await once(raw, 'connect')
    const secured = await authenticateStream(raw, endpoint.capability, 5000)
    sockets.add(secured)
    secured.on('error', () => {})
    secured.once('close', () => { sockets.delete(secured) })
    return secured
  }
  let facts: z.infer<typeof helloSchema> | undefined
  try { if (handshake) facts = await hello() } catch (error) { await close(); throw error }
  const connection = {
    ready: Promise.resolve(facts), nodeExecutable: process.execPath,
    request: <T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal) =>
      client.request(method, params, schema, signal),
    connectStream, dispose: close,
  }
  return { root, client, hello, close, serving, controller, facts, connection, connectStream }
}
