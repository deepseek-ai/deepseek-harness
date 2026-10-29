/** Node child evaluation over typed RPC; the host owns process lifetime. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Duplex } from 'node:stream'
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { createProcessRpc } from './rpc.ts'
import { captureStreamWrites, LogBuffer, makeConsoleShim, makeBindingErrorClass, makeNamespaces, prepareCompletion, prepareException } from './bootstrap.ts'
import type { BindingErrorConstructor, PatchableStream } from './bootstrap.ts'
import { clearProgramEnvironment } from './environment.ts'
import { createProgramEvaluator } from './evaluators/index.ts'
import type { ProgramEvaluator } from './evaluators/types.ts'
import { isEvaluationId, PROGRAM_PROTOCOL_VERSION } from './protocol.ts'
import type { BindingMethods, EvaluationId, EvaluationResult, ProgramResult, HostMethods, ProgramMethods } from './protocol.ts'

/** Process-owned environment, output and directory control consumed by the child. */
export interface ProgramProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  exitCode?: string | number | null | undefined
  chdir(directory: string): void
}

interface Evaluation {
  id: EvaluationId
  logs: LogBuffer
  maxOutputBytes: number
  active: boolean
  retainsState: boolean
  revoked: boolean
  finished: Promise<EvaluationResult>
  finish(result: ProgramResult): void
}

/**
 * Serve sequential evaluations until the host closes the control channel.
 * @param stream - Inherited, already-adopted control endpoint.
 * @param maxMessageBytes - Maximum control message and queued output bytes.
 * @param processState - Child environment, output, directory control and exit status.
 * @param defaultFormat - Syntax used by installed bootstraps when the host omits it.
 * @returns After control closure and evaluator cleanup.
 */
export async function runNodeMain(
  stream: Duplex, maxMessageBytes: number, processState: ProgramProcess, defaultFormat: PtcProgramFormat = 'function-body',
): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) throw new Error('invalid control message limit')
  clearProgramEnvironment(processState)
  const context = new AsyncLocalStorage<Evaluation>()
  const closed = Promise.withResolvers<void>()
  const errors = new Map<string, { name: string; memberNameProperty: string; constructor: BindingErrorConstructor }>()
  const errorLookup = { get: (name: string) => errors.get(name)?.constructor }
  const unsettled = new Promise<never>(() => {})
  let evaluator: ProgramEvaluator | undefined
  let current: Evaluation | undefined
  let lastEvaluationId = 0
  const acceptsCalls = (evaluation: Evaluation): boolean => evaluation.active && !evaluation.revoked
  const host: BindingMethods = {
    invoke: async (global, name, args) => {
      const evaluation = context.getStore()
      if (evaluation && !evaluation.active && !evaluation.retainsState) return unsettled
      if (!evaluation || !acceptsCalls(evaluation)) throw new Error('PTC evaluation ended')
      let value
      try { value = await connection.invoke(evaluation.id, global, name, args) } catch (error) {
        // Closing a temporary process must not resume an unawaited call with a rejection.
        if (!evaluation.active && !evaluation.retainsState) return unsettled
        throw error
      }
      if (!evaluation.active && !evaluation.retainsState) return unsettled
      if (!acceptsCalls(evaluation) || value === null) throw new Error('PTC evaluation canceled')
      return value
    },
  }
  const logSink = { push(text: string): void {
    const evaluation = context.getStore()
    if (evaluation && acceptsCalls(evaluation)) evaluation.logs.push(text)
  } }
  captureStreamWrites(logSink, processState.stdout)
  captureStreamWrites(logSink, processState.stderr)
  const connection = createProcessRpc<HostMethods, ProgramMethods>(stream, maxMessageBytes, {
    async run(id, cwd, data) {
      if (!isEvaluationId(id) || id <= lastEvaluationId || current?.active) throw new Error('invalid or overlapping PTC evaluation')
      lastEvaluationId = id
      const completion = Promise.withResolvers<EvaluationResult>()
      const logs = new LogBuffer(data.maxOutputBytes,
        (text) => { void connection.log(id, text) }, () => { void connection.outputLimit(id) })
      const format = data.programFormat ?? defaultFormat
      const evaluation: Evaluation = {
        id, logs, maxOutputBytes: data.maxOutputBytes, active: true, retainsState: data.retainsState, revoked: false,
        finished: completion.promise,
        finish(result) {
          evaluation.active = false
          if (evaluation.retainsState) {
            void connection.$rejectPendingCalls(({ reject }) => { reject(new Error('PTC evaluation ended')) })
          }
          completion.resolve({ evaluationId: id, ...evaluation.revoked ? { error: { kind: 'abort', message: 'PTC evaluation revoked' } } : result })
        },
      }
      current = evaluation
      context.run(evaluation, () => {
        try {
          processState.chdir(cwd)
          if (evaluator === undefined) {
            evaluator = createProgramEvaluator(format, (error) => {
              const active = context.getStore()
              if (active?.active && error) active.finish(prepareException(error, active.logs.remainingOutputBytes(), active.maxOutputBytes))
            })
            evaluator.globals.console = makeConsoleShim(logSink)
            // Context access must not reserve a function-body parameter named process.
            Object.defineProperty(evaluator.globals, 'process', { configurable: true, writable: true, value: processState })
          }
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
            Object.defineProperty(evaluator.globals, namespace.global, { configurable: true, enumerable: true, value: namespaces[index] })
            if (namespace.errorClass) {
              Object.defineProperty(evaluator.globals, namespace.errorClass.name, {
                configurable: true, enumerable: true, value: errorLookup.get(namespace.global),
              })
            }
          }
          evaluator.evaluate(data.code, (result) => {
            if (!evaluation.active) return
            if (evaluation.revoked) { evaluation.finish({}); return }
            evaluation.finish(result.ok ? prepareCompletion(result.value, logs.remainingOutputBytes(), data.maxOutputBytes)
              : prepareException(result.error, logs.remainingOutputBytes(), data.maxOutputBytes))
          })
        } catch (error: unknown) {
          evaluation.finish(prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes))
        }
      })
      return await completion.promise
    },
    async revoke(id) {
      if (!isEvaluationId(id) || id > lastEvaluationId) throw new Error('invalid PTC revocation identity')
      const evaluation = current
      if (evaluation?.id !== id || !evaluation.active) return
      evaluation.revoked = true
      void connection.$rejectPendingCalls(({ reject }) => { reject(new Error('PTC evaluation canceled')) })
      await evaluation.finished
    },
  }, ['ready', 'log', 'outputLimit'], (_error, kind) => {
    if (current?.active || kind === 'protocol') processState.exitCode = 1
    if (current) current.active = false
    closed.resolve()
  })
  try {
    await connection.ready(PROGRAM_PROTOCOL_VERSION)
    await closed.promise
  } finally {
    evaluator?.close()
    connection.$close()
    context.disable()
  }
}
