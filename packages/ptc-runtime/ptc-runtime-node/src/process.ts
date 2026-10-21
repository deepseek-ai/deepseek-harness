/** Node child evaluation over the shared process protocol; the host owns process lifetime. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Duplex } from 'node:stream'
import { JsonChannel } from './channel.ts'
import { captureStreamWrites, LogBuffer, makeConsoleShim, makeBindingErrorClass, makeNamespaces, prepareCompletion, prepareException, acceptReply } from './bootstrap.ts'
import type { BindingErrorConstructor, PendingCall, PatchableStream } from './bootstrap.ts'
import { clearProgramEnvironment } from './environment.ts'
import { createProgramEvaluator } from './evaluators/index.ts'
import type { ProgramEvaluator, ProgramFormat, ProgramImportHandler, ProgramImportResult } from './evaluators/types.ts'
import type { DoneMessage, ProgramBootData, ProgramToHost, ReplyMessage, RunMessage } from './protocol.ts'

/** Process-owned environment, output and optional directory control consumed by the child. */
export interface ProgramProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  exitCode?: string | number | null | undefined
  chdir?(directory: string): void
}

interface Evaluation {
  /** The standalone boot entry has no evaluation envelope. */
  id: number | undefined
  logs: LogBuffer
  maxOutputBytes: number
  active: boolean
  finish(result: Omit<DoneMessage, 'type'>): void
}

/**
 * Serve host evaluations until the host closes the control channel.
 * The standalone boot frame remains accepted by packaged worker probes.
 * @param stream - Inherited, already-adopted control endpoint.
 * @param maxMessageBytes - Maximum frame and queued-write bytes.
 * @param processState - Child environment, output streams, directory control and exit status.
 * @param defaultFormat - Syntax used by existing bootstraps when the host omits it.
 * @param importHandler - Runner-local import decisions; omission retains native loading.
 * @returns After control closure and evaluator cleanup; malformed startup rejects.
 */
export async function runNodeMain(
  stream: Duplex, maxMessageBytes: number, processState: ProgramProcess, defaultFormat: ProgramFormat = 'function-body',
  importHandler?: ProgramImportHandler,
): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0 || maxMessageBytes > 0xffff_ffff) throw new Error('invalid control message limit')
  clearProgramEnvironment(processState)
  const context = new AsyncLocalStorage<Evaluation>()
  const closed = Promise.withResolvers<void>()
  const pending = new Map<number, PendingCall>()
  const nextId = { value: 1 }
  const errors = new Map<string, { name: string; memberNameProperty: string; constructor: BindingErrorConstructor }>()
  const errorLookup = { get: (name: string) => errors.get(name)?.constructor }
  let evaluator: ProgramEvaluator | undefined
  let current: Evaluation | undefined
  const onClose = (): void => { closed.resolve() }
  const fail = (): void => {
    processState.exitCode = 1
    channel.close()
    closed.resolve()
  }
  const send = (id: number | undefined, payload: ProgramToHost): void => {
    void channel.send(id === undefined ? payload : { id, payload }).catch(fail)
  }
  const sender = {
    postMessage(payload: ProgramToHost): void {
      const evaluation = context.getStore()
      if (!evaluation?.active) throw new Error('PTC evaluation has ended; call this function from a new run_code evaluation')
      send(evaluation.id, payload)
    },
  }
  const logSink = { push(text: string): void { const evaluation = context.getStore(); if (evaluation?.active) evaluation.logs.push(text) } }
  captureStreamWrites(logSink, processState.stdout)
  captureStreamWrites(logSink, processState.stderr)
  const channel = new JsonChannel(stream, maxMessageBytes, (raw) => {
    // Host-owned run frames are trusted; model-written traffic is validated by the host.
    if (typeof raw !== 'object' || raw === null || !('type' in raw)
      || (raw.type !== 'run' && raw.type !== 'boot' && raw.type !== 'reply')
      || (raw.type === 'reply' && current === undefined)) {
      closed.reject(new Error('expected program boot or run frame'))
      channel.close()
      return
    }
    const message = raw as RunMessage | { type: 'boot'; data: ProgramBootData } | ReplyMessage
    if (message.type === 'reply') {
      acceptReply(pending, message)
      return
    }
    if (current?.active) { fail(); return }
    // Standalone workers finish exactly one program and then await host shutdown.
    if (current !== undefined && current.id === undefined) return
    const id = message.type === 'run' ? message.id : undefined
    const { data } = message
    const logs = new LogBuffer(data.maxOutputBytes, (text) => { send(id, { type: 'log', text }) }, () => { send(id, { type: 'output-limit' }) })
    const evaluation: Evaluation = {
      id, logs, maxOutputBytes: data.maxOutputBytes, active: true,
      finish(result) {
        if (!evaluation.active) return
        evaluation.active = false
        if (id !== undefined) {
          for (const call of pending.values()) call.reject(new Error('PTC evaluation ended before the binding completed'))
        }
        pending.clear()
        send(id, { type: 'done', ...result })
      },
    }
    current = evaluation
    context.run(evaluation, () => {
      try {
        if (message.type === 'run') {
          if (processState.chdir === undefined) throw new Error('Node program process cannot change its working directory')
          processState.chdir(message.cwd)
        }
        if (evaluator === undefined) {
          evaluator = createProgramEvaluator(data.programFormat ?? defaultFormat, (error) => {
            const active = context.getStore()
            if (active?.active && error) active.finish(prepareException(error, active.logs.remainingOutputBytes(), active.maxOutputBytes))
          }, importHandler === undefined ? undefined : (request) => {
            const active = context.getStore()
            if (!active?.active) throw new Error('PTC evaluation has ended; import modules from a new run_code evaluation')
            const result = importHandler(request)
            const checkActive = (decision: ProgramImportResult): ProgramImportResult => {
              if (!active.active) throw new Error('PTC evaluation ended before its import completed')
              return decision
            }
            return 'then' in result ? result.then(checkActive) : checkActive(result)
          })
          evaluator.globals.console = makeConsoleShim(logSink)
          Object.defineProperty(evaluator.globals, 'process', { configurable: true, enumerable: true, writable: true, value: processState })
        }
        for (const namespace of data.namespaces) {
          const descriptor = namespace.errorClass
          if (!descriptor) { errors.delete(namespace.global); continue }
          const previous = errors.get(namespace.global)
          if (previous?.name === descriptor.name && previous.memberNameProperty === descriptor.memberNameProperty) continue
          const constructor = makeBindingErrorClass(descriptor)
          errors.set(namespace.global, { name: descriptor.name, memberNameProperty: descriptor.memberNameProperty, constructor })
        }
        const namespaces = makeNamespaces(data, sender, pending, nextId, errorLookup)
        for (const [index, namespace] of data.namespaces.entries()) {
          Object.defineProperty(evaluator.globals, namespace.global, { configurable: true, enumerable: true, value: namespaces[index] })
          if (namespace.errorClass) {
            Object.defineProperty(evaluator.globals, namespace.errorClass.name, {
              configurable: true, enumerable: true, value: errorLookup.get(namespace.global),
            })
          }
        }
        evaluator.evaluate(data.code, (result) => {
          evaluation.finish(result.ok ? prepareCompletion(result.value, logs.remainingOutputBytes(), data.maxOutputBytes)
            : prepareException(result.error, logs.remainingOutputBytes(), data.maxOutputBytes))
        })
      } catch (error: unknown) {
        evaluation.finish(prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes))
      }
    })
  }, (error, kind) => {
    if (current === undefined && kind === 'protocol') closed.reject(error)
    if (current?.active || kind === 'protocol') fail()
    else closed.resolve()
  })
  stream.once('close', onClose)
  try {
    // Host closure can arrive before the readiness write receipt.
    await Promise.race([closed.promise, channel.send({ type: 'ready' }).then(() => closed.promise)])
    await channel.drain()
  } finally {
    stream.off('close', onClose)
    if (current) current.active = false
    evaluator?.close()
    channel.close()
    context.disable()
  }
}
