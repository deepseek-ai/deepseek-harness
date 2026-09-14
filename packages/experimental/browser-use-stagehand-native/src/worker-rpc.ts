/** One-shot MessagePorts carry browser operations and their results. */

import { MessageChannel, MessagePort } from 'node:worker_threads'
import type { Worker } from 'node:worker_threads'
import { z } from 'zod'

const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
])

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
 * @returns the receiver's value, rejecting malformed responses and peer shutdown.
 */
export async function request(target: MessagePort | Worker, method: string, args?: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const { port1, port2 } = new MessageChannel()
  const result = Promise.withResolvers<unknown>()
  const abort = () => {
    result.reject(signal?.reason instanceof Error ? signal.reason : new Error('Stagehand Worker request canceled'))
  }
  try {
    signal?.addEventListener('abort', abort, { once: true })
    port1.once('message', (raw: unknown) => {
      const response = responseSchema.safeParse(raw)
      if (!response.success) result.reject(response.error)
      else if (response.data.ok) result.resolve(response.data.value)
      else result.reject(new Error(response.data.error))
    })
    port1.once('messageerror', result.reject)
    port1.once('close', () => { result.reject(new Error('Stagehand Worker reply channel closed')) })
    try {
      target.postMessage({ method, args, reply: port2 }, [port2])
    } catch (error) {
      result.reject(error)
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
 * @param raw - untrusted message received from the Worker boundary.
 * @param execute - owner that validates and executes the method arguments.
 * @returns after the response has been posted and the reply port released.
 */
export async function answer(raw: unknown, execute: (method: string, args: unknown) => Promise<unknown>): Promise<void> {
  const { method, args, reply } = requestSchema.parse(raw)
  try {
    reply.postMessage({ ok: true, value: await execute(method, args) })
  } catch (error) {
    reply.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    reply.close()
  }
}
