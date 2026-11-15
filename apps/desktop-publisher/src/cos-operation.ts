/** Total deadlines and request cleanup for one qualification COS operation. */
import * as http from 'node:http'
import * as https from 'node:https'
import type COS from 'cos-nodejs-sdk-v5'

/**
 * Run one SDK operation with a shared deadline across its HTTP attempts.
 * @param cos Client dedicated to this operation, with no concurrent users.
 * @param timeoutMs Total network-operation budget in milliseconds.
 * @param operation SDK call whose result is returned after its requests close.
 * @returns SDK result; expiration rejects with TimeoutError after aborting the transport.
 */
export async function cosOperation<T>(cos: COS, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timeout = new Error('installed update: COS operation exceeded its deadline')
  timeout.name = 'TimeoutError'
  const closed: Promise<void>[] = []
  const wrap = (transport: typeof http | typeof https) => ({
    ...transport,
    request(options: http.RequestOptions) {
      const request = transport.request({ ...options, signal: controller.signal })
      closed.push(new Promise<void>((resolve) => { request.once('close', resolve) }))
      return request
    },
  })
  const modules = { 'http:': wrap(http), 'https:': wrap(https) }
  // cos-request forwards httpModules to its native request layer, including every SDK retry.
  const configure = (options: { httpModules?: typeof modules }): void => { options.httpModules = modules }
  cos.on('before-send', configure)
  const timer = setTimeout(() => { controller.abort(timeout) }, timeoutMs)
  try {
    const result = await operation()
    if (controller.signal.aborted) throw timeout
    return result
  } catch (error) {
    if (controller.signal.aborted) throw timeout
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
    await Promise.all(closed)
    cos.off('before-send', configure)
  }
}
