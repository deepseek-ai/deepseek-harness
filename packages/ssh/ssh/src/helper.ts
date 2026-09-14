/** Private POSIX SSH helper; filesystem and process effects use the installed local providers. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { FsError, type FsTarget, type FsWriteIntent, type FsVersion } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { z } from 'zod'
import { SshRpcPeer, RemoteOperationError, SSH_MAX_PROCESS_HANDLES, SSH_MAX_TEXT_STREAMS, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { RemoteProcesses } from './helper-processes.ts'
import { editSchema, environmentSchema, intentSchema, policySchema, processIdSchema, remotePath, targetSchema, textStreamIdSchema } from './schemas.ts'
import type { SshTextStreamId } from './schemas.ts'

const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const object = z.object({}).strict()
const processIdRequest = z.object({ id: processIdSchema }).strict()
const textStreamIdRequest = z.object({ id: textStreamIdSchema }).strict()

async function services() {
  const ctx = new Context()
  const fibers = [await ctx.plugin(SessionProjectionRegistry)]
  fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() }))
  fibers.push(await ctx.plugin(SandboxedFileSystem, { cwd: process.cwd() }))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  fibers.push(await ctx.plugin(LocalSandboxProvider))
  return { ctx, close: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

/** The private helper's authenticated transport and process lifetime. */
export interface HelperTransport {
  /** Authenticated request bytes from OpenSSH. */
  input: Readable
  /** Responses carried only by OpenSSH exec stdout. */
  output: Writable
  /** Installed entry whose digest is compared by the client. */
  entryPath: string
  /** Process termination joins the same cleanup as transport loss. */
  signal: AbortSignal
}

/**
 * Run a helper until its channel closes or its client lease expires.
 * @param transport - private process streams, entry identity, and cancellation.
 */
export async function runSshHelper(transport: HelperTransport): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH helper requires a POSIX host')
  transport.signal.throwIfAborted()
  const runtime = await services()
  const { ctx } = runtime
  const root = await mkdtemp('/tmp/dsh-ssh-')
  const processes = new RemoteProcesses(ctx, root, SSH_MAX_PROCESS_HANDLES, 30_000)
  const lifetime = new AbortController()
  const iterators = new Map<SshTextStreamId, { iterator: AsyncIterator<string>; controller: AbortController }>()
  let lease: NodeJS.Timeout | undefined
  let leaseMs = 30_000
  let initialized = false
  let workspace = process.cwd()
  let cleanup: Promise<void> | undefined
  const close = (): Promise<void> => {
    cleanup ??= (async () => {
      if (lease !== undefined) clearTimeout(lease)
      lifetime.abort(new Error('SSH helper is closing'))
      for (const record of iterators.values()) record.controller.abort(lifetime.signal.reason)
      await Promise.allSettled([...iterators.values()].map(async record => record.iterator.return?.()))
      iterators.clear()
      try { await processes.close() }
      finally {
        try { await runtime.close() }
        finally { await rm(root, { recursive: true, force: true }) }
      }
    })()
    return cleanup
  }
  const touchLease = (): void => {
    if (lease !== undefined) clearTimeout(lease)
    lease = setTimeout(() => { peer.close(new Error('SSH helper client lease expired')) }, leaseMs)
  }
  const policy = async (raw: unknown, signal: AbortSignal): Promise<SandboxExecutionPolicy> => {
    const parsed = policySchema.parse(raw)
    const target = await ctx.fs.resolve(parsed.workspaceRoot, { signal })
    return { ...parsed, workspaceRoot: ctx.fs.processPath(target) } as SandboxExecutionPolicy
  }
  const asTarget = (raw: unknown): FsTarget => targetSchema.parse(raw) as FsTarget
  const peer = new SshRpcPeer(transport.input, transport.output, MAX_FRAME_BYTES, 128, async (method, raw, requestSignal) => {
    const signal = AbortSignal.any([requestSignal, lifetime.signal])
    if (method === 'hello') {
      if (initialized) throw new Error('SSH helper handshake already completed')
      const input = z.object({
        protocol: z.literal(SSH_PROTOCOL_VERSION), workspace: remotePath, leaseMs: z.number().int().min(3000).max(600_000),
        bootstrapPath: remotePath.optional(),
      }).strict().parse(raw)
      workspace = ctx.fs.processPath(await ctx.fs.resolve(input.workspace, { signal }))
      leaseMs = input.leaseMs
      initialized = true
      touchLease()
      return {
        protocol: SSH_PROTOCOL_VERSION, hash: createHash('sha256').update(readFileSync(transport.entryPath)).digest('hex'),
        platform: process.platform, nodeVersion: process.version, node: process.execPath, root, workspace,
        ...(input.bootstrapPath === undefined ? {} : { bootstrapHash: createHash('sha256').update(readFileSync(input.bootstrapPath)).digest('hex') }),
      }
    }
    if (!initialized || cleanup !== undefined) throw new Error('SSH helper is not accepting operations')
    if (method === 'heartbeat') { object.parse(raw); touchLease(); return null }
    if (method === 'close') { object.parse(raw); await close(); return null }
    if (method === 'process.prepare') return processes.prepare(raw)
    if (method === 'process.start') return processes.start(processIdRequest.parse(raw).id, signal)
    if (method === 'process.done') return processes.done(processIdRequest.parse(raw).id)
    if (method === 'process.wait') return processes.wait(processIdRequest.parse(raw).id, signal)
    if (method === 'process.terminate') { await processes.terminate(processIdRequest.parse(raw).id); return null }
    if (method === 'terminal.environment') { object.parse(raw); return ctx.subprocess.terminalEnvironment(signal) }
    if (method === 'terminal.resize') {
      const input = z.object({
        id: processIdSchema, cols: z.number().int().positive(), rows: z.number().int().positive(),
      }).strict().parse(raw)
      await processes.resizeTerminal(input.id, input.cols, input.rows)
      return null
    }
    if (method === 'terminal.write' || method === 'terminal.inspect' || method === 'terminal.signal') {
      const input = z.object({ id: processIdSchema, value: z.string().optional() }).strict().parse(raw)
      return processes.terminal(input.id, method === 'terminal.write' ? 'write' : method === 'terminal.inspect' ? 'inspect' : 'signal', input.value)
    }
    if (method === 'executable') {
      const input = z.object({ command: z.string(), env: environmentSchema.optional() }).strict().parse(raw)
      const env = input.env === undefined ? undefined : Object.fromEntries(
        Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== null),
      )
      try {
        return await ctx.subprocess.resolveExecutable(input.command, env, signal)
      } catch (error) {
        if (error instanceof SubprocessExecutableNotFoundError) throw new RemoteOperationError(error.message, 'SUBPROCESS_EXECUTABLE_NOT_FOUND')
        throw error
      }
    }
    if (method === 'sandbox') {
      const input = z.object({ argv: z.array(z.string()).min(1), policy: policySchema }).strict().parse(raw)
      const resolved = await policy(input.policy, signal)
      if (resolved.mode === 'danger-full-access') throw new Error('Unconfined argv does not need a sandbox wrapper')
      return ctx.sandbox.confine(input.argv, resolved as SandboxPolicy, signal)
    }
    if (method === 'fs.resolve' || method === 'fs.lstat') {
      const input = z.object({ path: z.string(), cwd: remotePath.optional() }).strict().parse(raw)
      return method === 'fs.resolve' ? ctx.fs.resolve(input.path, { cwd: input.cwd ?? workspace, signal }) : await ctx.fs.lstat(input.path, { cwd: input.cwd ?? workspace }, signal) ?? null
    }
    if (method === 'fs.stat' || method === 'fs.list' || method === 'fs.readText' || method === 'fs.stream') {
      const target = asTarget(z.object({ target: targetSchema }).strict().parse(raw).target)
      if (method === 'fs.stat') return await ctx.fs.stat(target, signal) ?? null
      if (method === 'fs.list') return ctx.fs.listDir(target, signal)
      if (method === 'fs.stream') {
        if (iterators.size >= SSH_MAX_TEXT_STREAMS) throw new Error('SSH text stream limit reached')
        const controller = new AbortController()
        const stream = await ctx.fs.streamText(target, AbortSignal.any([signal, controller.signal]))
        const iterator = stream[Symbol.asyncIterator]()
        try {
          signal.throwIfAborted()
          if (iterators.size >= SSH_MAX_TEXT_STREAMS) throw new Error('SSH text stream limit reached')
          const id = randomUUID() as SshTextStreamId
          iterators.set(id, { iterator, controller })
          return id
        } catch (error) {
          controller.abort(error)
          await iterator.return?.()
          throw error
        }
      }
      const stream = await ctx.fs.streamText(target, signal)
      let text = ''
      let bytes = 0
      for await (const chunk of stream) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_TEXT_BYTES) throw new FsError('SSH whole-text transfer exceeds its bounded frame budget; use streaming', 'FS_TOO_LARGE')
        text += chunk
      }
      return text
    }
    if (method === 'fs.next' || method === 'fs.streamClose') {
      const { id } = textStreamIdRequest.parse(raw)
      const record = iterators.get(id)
      if (record === undefined) throw new Error('Unknown SSH text stream')
      if (method === 'fs.streamClose') {
        iterators.delete(id)
        record.controller.abort(new Error('SSH text stream closed'))
        await record.iterator.return?.()
        return null
      }
      const abort = (): void => { record.controller.abort(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        const next = await record.iterator.next()
        if (next.done) iterators.delete(id)
        return { done: next.done ?? false, value: next.done ? '' : next.value }
      } catch (error) {
        iterators.delete(id)
        record.controller.abort(error)
        await record.iterator.return?.()
        throw error
      } finally { signal.removeEventListener('abort', abort) }
    }
    if (method === 'fs.readBytes' || method === 'fs.readRange') {
      const input = z.object({
        target: targetSchema, maxBytes: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
      }).strict().parse(raw)
      const target = asTarget(input.target)
      const bytes = method === 'fs.readBytes'
        ? await ctx.fs.readBytes(target, signal, Math.min(z.number().int().nonnegative().parse(input.maxBytes), MAX_TEXT_BYTES))
        : await ctx.fs.readByteRange(target, {
          offset: z.number().int().nonnegative().parse(input.offset),
          length: z.number().int().nonnegative().max(MAX_TEXT_BYTES).parse(input.length),
        }, signal)
      return Buffer.from(bytes).toString('base64')
    }
    if (method === 'fs.write' || method === 'fs.edit') {
      const input = z.object({
        target: targetSchema, content: z.string().optional(), edit: editSchema.optional(),
        expected: z.union([intentSchema, z.object({ version: z.string() }).strict()]).optional(), policy: policySchema,
      }).strict().parse(raw)
      const target = asTarget(input.target)
      const resolved = await policy(input.policy, signal)
      if (method === 'fs.write') return ctx.fs.writeText(
        target, z.string().parse(input.content),
        input.expected === undefined ? undefined : intentSchema.parse(input.expected) as FsWriteIntent, signal, resolved,
      )
      return ctx.fs.editText(
        target, editSchema.parse(input.edit),
        input.expected === undefined
          ? undefined : z.object({ version: z.string() }).strict().parse(input.expected) as { version: FsVersion },
        signal, resolved,
      )
    }
    throw new Error(`Unknown SSH helper operation: ${method}`)
  })
  const closed = Promise.withResolvers<undefined>()
  peer.once('closed', () => {
    void close().catch(() => {})
    closed.resolve(undefined)
  })
  const onAbort = (): void => { peer.close(new Error('SSH helper transport was terminated')) }
  transport.signal.addEventListener('abort', onAbort, { once: true })
  if (transport.signal.aborted) onAbort()
  else touchLease()
  try { await closed.promise; await close() }
  finally { transport.signal.removeEventListener('abort', onAbort) }

}
