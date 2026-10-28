/** Runs index parsing in a fresh Worker Thread, so a large index does not block the Host event loop. */
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { IndexParseRequest, IndexParseResult } from './parse.ts'

function workerSpawn(): { readonly entry: URL; readonly options: WorkerOptions } {
  /* v8 ignore next -- built-artifact runs own the bundled path. */
  if (!import.meta.url.endsWith('.ts')) return { entry: new URL('./worker.cjs', import.meta.url), options: { execArgv: [] } }
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(new URL('./worker.ts', import.meta.url).href)})`,
  ].join('\n')
  return { entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), options: { execArgv: [] } }
}

/** Whether a Worker message is a parse result: an index object, or a violation's path, reason, and message. */
function isResult(value: unknown): value is IndexParseResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return result.ok === true
    ? typeof result.index === 'object' && result.index !== null
    : result.ok === false && [result.path, result.reason, result.message].every(field => typeof field === 'string')
}

/**
 * Run `parseIndexBody` in a fresh Worker Thread. The body's buffer is transferred to the Worker and is unusable
 * afterwards; the result is copied back by structured clone.
 * @param body - the complete response body; it must own its whole buffer.
 * @param url - the index URL.
 * @param signal - terminates the Worker and rejects with the signal's reason.
 * @returns the Worker's result.
 * @throws the abort reason, or an Error when the Worker fails, exits without a result, or reports an unexpected value.
 */
export async function parseIndexInWorker(body: Uint8Array, url: string, signal: AbortSignal): Promise<IndexParseResult> {
  signal.throwIfAborted()
  const { entry, options } = workerSpawn()
  const request: IndexParseRequest = { body, url }
  const worker = new Worker(entry, { ...options, workerData: request, transferList: [body.buffer as ArrayBuffer] })
  return await new Promise((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      // The outcome stands whether or not termination succeeds.
      void worker.terminate().then(finish, finish)
    }
    const abort = (): void => { settle(() => { reject(signal.reason as Error) }) }
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (value: unknown) => {
      settle(() => { if (isResult(value)) resolve(value); else reject(new Error('index parser reported an unexpected value')) })
    })
    worker.once('error', (error) => { settle(() => { reject(error) }) })
    worker.once('exit', (code) => { settle(() => { reject(new Error(`index parser exited before reporting a result (code ${String(code)})`)) }) })
  })
}
