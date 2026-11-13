/** One-shot MessagePorts carry browser operations and their results. */

import { MessageChannel, MessagePort } from 'node:worker_threads'
import type { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { isStagehandErrorCode, StagehandError } from './error.ts'

const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string(), name: z.string().optional(), code: z.string().optional() }).strict(),
])

/**
 * Rebuild a Worker operation failure on the host. A {@link StagehandError}
 * keeps its code; any other failure, including an unknown name or code,
 * becomes `STAGEHAND_OPERATION_FAILED` with the Worker's message.
 */
function operationFailure(failure: { error: string; name?: string | undefined; code?: string | undefined }): StagehandError {
  return failure.name === 'StagehandError' && isStagehandErrorCode(failure.code)
    ? new StagehandError(failure.error, failure.code)
    : new StagehandError(failure.error, 'STAGEHAND_OPERATION_FAILED')
}

function workerFailure(message: string, cause?: unknown): StagehandError {
  return new StagehandError(message, 'STAGEHAND_WORKER_FAILED', cause === undefined ? undefined : { cause })
}

/** Transferable reply channel paired with a validated operation payload. */
export const requestSchema = z.object({
  method: z.string(),
  args: z.unknown(),
  reply: z.instanceof(MessagePort),
}).strict()

/**
 * Send one request and release its reply port after response or peer shutdown.
 * @param target - owning Worker or parent port.
 * @param method - operation understood by the receiver.
 * @param args - structured-cloneable request data.
 * @param signal - owning Worker lifetime, when observed by the caller.
 * @returns the receiver's value. Malformed responses and peer shutdown reject with `STAGEHAND_WORKER_FAILED`;
 * a receiver failure rejects as rebuilt by its `StagehandError` code.
 */
export async function request(target: MessagePort | Worker, method: string, args?: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const { port1, port2 } = new MessageChannel()
  const result = Promise.withResolvers<unknown>()
  const abort = () => {
    result.reject(signal?.reason instanceof Error ? signal.reason : workerFailure('Stagehand Worker request canceled', signal?.reason))
  }
  const transportFailure = (error: Error): void => { result.reject(workerFailure(error.message, error)) }
  try {
    signal?.addEventListener('abort', abort, { once: true })
    port1.once('message', (raw: unknown) => {
      const response = responseSchema.safeParse(raw)
      if (!response.success) result.reject(workerFailure('Stagehand Worker returned a malformed response', response.error))
      else if (response.data.ok) result.resolve(response.data.value)
      else result.reject(operationFailure(response.data))
    })
    port1.once('messageerror', transportFailure)
    port1.once('close', () => { result.reject(workerFailure('Stagehand Worker reply channel closed')) })
    try {
      target.postMessage({ method, args, reply: port2 }, [port2])
    } catch (error) {
      // postMessage reports clone and transfer failures as DOMException instances.
      transportFailure(error as Error)
    }
    return await result.promise
  } finally {
    signal?.removeEventListener('abort', abort)
    port1.close()
    port2.close()
  }
}

/**
 * Validate and answer one request without leaving rejected callbacks unobserved.
 * A rejected {@link StagehandError} sends its `name` and `code` beside the message.
 * @param raw - untrusted message received from the Worker boundary.
 * @param execute - owner that validates and executes the method arguments.
 * @returns after the response has been posted and the reply port released.
 */
export async function answer(raw: unknown, execute: (method: string, args: unknown) => Promise<unknown>): Promise<void> {
  const { method, args, reply } = requestSchema.parse(raw)
  try {
    reply.postMessage({ ok: true, value: await execute(method, args) })
  } catch (error) {
    reply.postMessage(error instanceof StagehandError
      ? { ok: false, error: error.message, name: error.name, code: error.code }
      : { ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    reply.close()
  }
}
