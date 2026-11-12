/** Node child evaluation over typed RPC; the host owns process lifetime. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { inspect } from 'node:util'
import type { Duplex } from 'node:stream'
import type { PtcProgramFormat, PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import { createProcessRpc } from './rpc.ts'
import { captureStreamWrites, LogBuffer, makeInspect, makeBindingErrorClass, makeNamespaces, outputLimit, prepareCompletion, prepareException } from './bootstrap.ts'
import type { BindingErrorConstructor, ImageInspectOptions, PatchableStream } from './bootstrap.ts'
import type { PtcImageWire } from './json-wire.ts'
import { clearProgramEnvironment, filterRuntimeWarnings } from './environment.ts'
import { createProgramEvaluator } from './evaluators/index.ts'
import { ImportEvaluationEndedError } from './imports/evaluation-ended.ts'
import type { ProgramEvaluator, ProgramImportHandler, ProgramImportResult } from './evaluators/types.ts'
import { PROGRAM_PROTOCOL_VERSION, type ProgramResult, type HostMethods, type ProgramMethods } from './protocol.ts'

const capturedObjectCreate = Object.create
const capturedObjectDefineProperty = Object.defineProperty
const capturedObjectFreeze = Object.freeze
const nativeConsole = globalThis.console

/** Process-owned environment, output and directory control consumed by the child. */
export interface ProgramProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  exitCode?: string | number | null | undefined
  chdir(directory: string): void
  /** Node's warning emitter; the child drops warnings from the runtime's own experimental features. */
  emitWarning?: typeof process.emitWarning
}

interface Evaluation {
  logs: LogBuffer
  maxOutputBytes: number
  active: boolean
  reusable: boolean
  revoked: boolean
  finish(result: ProgramResult): void
}

/**
 * Serve sequential evaluations until the host closes the control channel.
 * @param stream - Inherited, already-adopted control endpoint.
 * @param maxMessageBytes - Maximum control message and queued output bytes.
 * @param processState - Native child process; structural test doubles do not replace Node's globals or built-in exports.
 * @param defaultFormat - Syntax used by installed bootstraps when the host omits it.
 * @param importHandler - Runner-local import decisions; omission retains native loading.
 * @returns After control closure and evaluator cleanup.
 */
export async function runNodeMain(
  stream: Duplex, maxMessageBytes: number, processState: ProgramProcess, defaultFormat: PtcProgramFormat = 'function-body',
  importHandler?: ProgramImportHandler,
): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) throw new Error('invalid control message limit')
  clearProgramEnvironment(processState)
  filterRuntimeWarnings(processState)
  const context = new AsyncLocalStorage<Evaluation>()
  const closed = Promise.withResolvers<void>()
  const errors = new Map<string, { name: string; memberNameProperty: string; constructor: BindingErrorConstructor }>()
  const errorLookup = { get: (name: string) => errors.get(name)?.constructor }
  const unsettled = new Promise<never>(() => {})
  let evaluator: ProgramEvaluator | undefined
  let current: Evaluation | undefined
  const acceptsCalls = (evaluation: Evaluation): boolean => evaluation.active && !evaluation.revoked
  const host: Pick<HostMethods, 'invoke'> = {
    invoke: async (global, name, args) => {
      const evaluation = context.getStore()
      if (evaluation && !evaluation.active && !evaluation.reusable) return unsettled
      if (!evaluation || !acceptsCalls(evaluation)) throw new Error('PTC evaluation ended')
      let value
      try { value = await connection.invoke(global, name, args) } catch (error) {
        // Closing a temporary process must not resume an unawaited call with a rejection.
        if (!evaluation.active && !evaluation.reusable) return unsettled
        throw error
      }
      if (!evaluation.active && !evaluation.reusable) return unsettled
      if (!acceptsCalls(evaluation)) throw new Error('PTC evaluation canceled')
      return value
    },
  }
  const images = new WeakMap<object, string>()
  class Image {
    readonly [key: string]: PtcJsonValue
    declare readonly attachmentId: string
    declare readonly path: string
    declare readonly width: number
    declare readonly height: number
    private constructor() { throw new Error('Images are created by image-producing tools') }
    [inspect.custom](_depth: number | null, options: ImageInspectOptions): this {
      collectImage(this, options)
      return this
    }
  }
  const decodeImage = (wire: PtcImageWire): PtcJsonValue => {
    const image = capturedObjectCreate(Image.prototype) as Image
    for (const key of ['attachmentId', 'path', 'width', 'height'] as const) {
      const descriptor = capturedObjectCreate(null) as PropertyDescriptor
      descriptor.enumerable = true
      descriptor.value = wire[key]
      capturedObjectDefineProperty(image, key, descriptor)
    }
    capturedObjectFreeze(image)
    images.set(image, wire.id)
    return image
  }
  const imageSink = (id: string): void => {
    const evaluation = context.getStore()
    if (evaluation && acceptsCalls(evaluation)) void connection.image(id)
  }
  const logSink = { push(text: string): void {
    const evaluation = context.getStore()
    if (evaluation && acceptsCalls(evaluation)) evaluation.logs.push(text)
  } }
  const { inspect: programInspect, collectImage } = makeInspect(logSink, images, imageSink)
  captureStreamWrites(logSink, processState.stdout)
  captureStreamWrites(logSink, processState.stderr)
  const connection = createProcessRpc<HostMethods, ProgramMethods>(stream, maxMessageBytes, {
    async run(cwd, data) {
      if (current?.active) throw new Error('overlapping PTC evaluation')
      const completion = Promise.withResolvers<ProgramResult>()
      const logs = new LogBuffer(data.maxOutputBytes,
        (text) => { void connection.log(text) }, () => { void connection.outputLimit() })
      const format = data.programFormat ?? defaultFormat
      const evaluation: Evaluation = {
        logs, maxOutputBytes: data.maxOutputBytes, active: true, reusable: data.retainsState, revoked: false,
        finish(result) {
          evaluation.active = false
          if (evaluation.reusable) {
            void connection.$rejectPendingCalls(({ reject }) => { reject(new Error('PTC evaluation ended')) })
          }
          completion.resolve(result)
        },
      }
      current = evaluation
      const canContinue = (): boolean => {
        if (!evaluation.active) return false
        if (!evaluation.revoked) return true
        evaluation.finish({})
        return false
      }
      void context.run(evaluation, async () => {
        try {
          processState.chdir(cwd)
          if (evaluator === undefined) {
            evaluator = createProgramEvaluator(format, (error) => {
              const active = context.getStore()
              if (active?.active && error) active.finish(prepareException(error, active.logs.remainingOutputBytes(), active.maxOutputBytes))
            }, importHandler === undefined ? undefined : (request) => {
              const active = context.getStore()
              if (!active?.active) throw new ImportEvaluationEndedError(active?.reusable ?? true)
              const result = importHandler(request)
              const checkActive = (decision: ProgramImportResult): ProgramImportResult => {
                if (!active.active) throw new ImportEvaluationEndedError(active.reusable, true)
                return decision
              }
              return 'then' in result ? result.then(checkActive, (error: unknown) => {
                if (!active.active) throw new ImportEvaluationEndedError(active.reusable, true)
                throw error
              }) : checkActive(result)
            })
            // Context access must not reserve a function-body parameter named process.
            Object.defineProperty(evaluator.globals, 'process', { configurable: true, writable: true, value: processState })
            Object.defineProperty(evaluator.globals, 'inspect', {
              configurable: true, enumerable: true, value: programInspect,
            })
            Object.defineProperty(evaluator.globals, 'Image', { configurable: true, enumerable: true, value: Image })
            if (format !== 'function-body') Object.defineProperty(evaluator.globals, 'console', {
              configurable: true, enumerable: true, writable: true, value: nativeConsole,
            })
          }
          for (const namespace of data.namespaces) {
            const descriptor = namespace.errorClass
            if (!descriptor) { errors.delete(namespace.global); continue }
            const previous = errors.get(namespace.global)
            if (previous?.name === descriptor.name && previous.memberNameProperty === descriptor.memberNameProperty) continue
            const constructor = makeBindingErrorClass(descriptor)
            errors.set(namespace.global, { name: descriptor.name, memberNameProperty: descriptor.memberNameProperty, constructor })
          }
          const namespaces = makeNamespaces(data, host, errorLookup, decodeImage)
          for (const [index, namespace] of data.namespaces.entries()) {
            Object.defineProperty(evaluator.globals, namespace.global, { configurable: true, enumerable: true, value: namespaces[index] })
            if (namespace.errorClass) {
              Object.defineProperty(evaluator.globals, namespace.errorClass.name, {
                configurable: true, enumerable: true, value: errorLookup.get(namespace.global),
              })
            }
          }
          const programEvaluator = evaluator
          const initialization = data.initialization
          if (initialization !== undefined) {
            await new Promise<void>((resolve, reject) => {
              programEvaluator.evaluate(initialization, (result) => {
                if (result.ok) resolve()
                // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Programs may throw non-Error values.
                else reject(result.error)
              })
            })
            if (!canContinue()) return
            if (logs.overflowed) {
              evaluation.finish(outputLimit(data.maxOutputBytes))
              return
            }
            await connection.initialized()
          }
          if (!canContinue()) return
          programEvaluator.evaluate(data.code, (result) => {
            if (!canContinue()) return
            evaluation.finish(result.ok
              ? data.discardCompletion ? {} : prepareCompletion(result.value, logs.remainingOutputBytes(), data.maxOutputBytes)
              : prepareException(result.error, logs.remainingOutputBytes(), data.maxOutputBytes))
          })
        } catch (error: unknown) {
          if (canContinue()) evaluation.finish(prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes))
        }
      })
      return await completion.promise
    },
    revoke() {
      const evaluation = current
      if (!evaluation?.active) return
      evaluation.revoked = true
      void connection.$rejectPendingCalls(({ reject }) => { reject(new Error('PTC evaluation canceled')) })
    },
  }, ['ready', 'log', 'image', 'outputLimit'], (_error, kind) => {
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
