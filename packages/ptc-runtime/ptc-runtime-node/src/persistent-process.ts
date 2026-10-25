/** In-memory Node REPL with per-evaluation bindings and output attribution. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { start } from 'node:repl'
import { PassThrough, Writable, type Duplex } from 'node:stream'
import { createProcessRpc } from './rpc.ts'
import { captureStreamWrites, LogBuffer, makeConsoleShim, makeBindingErrorClass, makeNamespaces, prepareCompletion, prepareException } from './bootstrap.ts'
import type { BindingErrorConstructor, PatchableStream } from './bootstrap.ts'
import type { ProgramResult, HostMethods, ProgramMethods } from './protocol.ts'
import { clearProgramEnvironment } from './environment.ts'

/** Process state owned by the REPL child; tests supply instance-local streams and environment. */
export interface PersistentProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  chdir(directory: string): void
}

interface Evaluation {
  logs: LogBuffer
  maxOutputBytes: number
  active: boolean
  finish(result: ProgramResult): void
}

/**
 * Serve sequential evaluations until the owning host closes the control channel.
 * @param stream - Inherited private control endpoint.
 * @param maxMessageBytes - Maximum control message and queued output bytes.
 * @param processState - Child environment, output and directory control, bound only in the REPL context.
 * @returns After the channel closes and the REPL releases its streams.
 */
export async function runPersistentMain(stream: Duplex, maxMessageBytes: number, processState: PersistentProcess): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) throw new Error('invalid control message limit')
  clearProgramEnvironment(processState)
  const context = new AsyncLocalStorage<Evaluation>()
  const closed = Promise.withResolvers<void>()
  const errors = new Map<string, { name: string; memberNameProperty: string; constructor: BindingErrorConstructor }>()
  const errorLookup = { get: (name: string) => errors.get(name)?.constructor }
  const input = new PassThrough()
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const current = context.getStore()
    const message = chunk.toString().trim()
    if (current?.active && message) current.finish(prepareException(message, current.logs.remainingOutputBytes(), current.maxOutputBytes))
    callback()
  } })
  const repl = start({ input, output, terminal: false, prompt: '', useGlobal: false, ignoreUndefined: true })
  // Interactive result setters print notices; program assignments use ordinary retained globals.
  for (const name of ['_', '_error']) {
    Object.defineProperty(repl.context, name, { configurable: true, enumerable: true, writable: true, value: undefined })
  }
  let current: Evaluation | undefined
  const host: Pick<HostMethods, 'invoke'> = {
    invoke: (global, name, args) => {
      const evaluation = context.getStore()
      if (!evaluation?.active) throw new Error('PTC evaluation has ended; call this function from a new run_code evaluation')
      return connection.invoke(global, name, args)
    },
  }
  const logSink = { push(text: string): void { const evaluation = context.getStore(); if (evaluation?.active) evaluation.logs.push(text) } }
  repl.context.console = makeConsoleShim(logSink)
  Object.defineProperty(repl.context, 'process', { configurable: true, enumerable: true, writable: true, value: processState })
  captureStreamWrites(logSink, processState.stdout)
  captureStreamWrites(logSink, processState.stderr)
  const connection = createProcessRpc<HostMethods, ProgramMethods>(stream, maxMessageBytes, {
    async run(cwd, data) {
      const completion = Promise.withResolvers<ProgramResult>()
      const logs = new LogBuffer(data.maxOutputBytes, (text) => { void connection.log(text) }, () => { void connection.outputLimit() })
      const evaluation: Evaluation = {
        logs, maxOutputBytes: data.maxOutputBytes, active: true,
        finish(result) {
          if (!evaluation.active) return
          evaluation.active = false
          void connection.$rejectPendingCalls(({ reject }) => { reject(new Error('PTC evaluation ended before the binding completed')) })
          completion.resolve(result)
        },
      }
      current = evaluation
      context.run(evaluation, () => {
        try {
          processState.chdir(cwd)
          for (const namespace of data.namespaces) {
            const descriptor = namespace.errorClass
            if (!descriptor) { errors.delete(namespace.global); continue }
            const previous = errors.get(namespace.global)
            if (previous?.name === descriptor.name && previous.memberNameProperty === descriptor.memberNameProperty) continue
            const constructor = makeBindingErrorClass(descriptor)
            errors.set(namespace.global, { name: descriptor.name, memberNameProperty: descriptor.memberNameProperty, constructor })
          }
          const namespaces = makeNamespaces(data, host, errorLookup)
          for (const [index, namespace] of data.namespaces.entries()) {
            Object.defineProperty(repl.context, namespace.global, { configurable: true, value: namespaces[index] })
            if (namespace.errorClass) {
              Object.defineProperty(repl.context, namespace.errorClass.name, {
                configurable: true, value: errorLookup.get(namespace.global),
              })
            }
          }
          // Node's REPL treats a leading brace as an object expression before transforming await.
          const program = data.code.trimStart().startsWith('{') ? `;${data.code}` : data.code
          repl.eval(`${program}\n`, repl.context, 'ptc-repl', (error: Error | null, value: unknown) => {
            evaluation.finish(error ? prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes)
              : prepareCompletion(value, logs.remainingOutputBytes(), data.maxOutputBytes))
          })
        } catch (error: unknown) {
          evaluation.finish(prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes))
        }
      })
      return await completion.promise
    },
  }, ['ready', 'log', 'outputLimit'], () => {
    // An inactive evaluation sends nothing more over the closed endpoint.
    if (current) current.active = false
    closed.resolve()
  })
  try {
    await connection.ready()
    await closed.promise
  } finally {
    repl.close()
    input.destroy()
    output.destroy()
    context.disable()
  }
}
