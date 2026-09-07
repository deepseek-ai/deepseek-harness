/** Isolated verification for a staged or competing current JSONL generation. */

import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import type { JsonlCompression } from './format.ts'
import type { JsonlExpectedPrefix, JsonlVerifiedGeneration } from './generation.ts'

interface VerificationRequest {
  readonly path: string
  readonly compression: JsonlCompression
  readonly expectedId: string
  readonly expectedEventCount: number
  readonly expectedPrefix?: JsonlExpectedPrefix
}

type VerificationResponse =
  | { readonly ok: true; readonly result: JsonlVerifiedGeneration }
  | { readonly ok: false; readonly message: string; readonly stack?: string }

/** Process-wide memory bound for full-generation verification isolates. */
const MAX_CONCURRENT_VERIFIERS = 2

class VerificationScheduler {
  private active = 0
  private readonly waiting: Array<{ grant(): void }> = []

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const permit = this.acquire(signal)
    if (permit !== undefined) await permit
    try {
      signal?.throwIfAborted()
      return await operation()
    } finally {
      this.release()
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> | undefined {
    signal?.throwIfAborted()
    if (this.active < MAX_CONCURRENT_VERIFIERS) {
      this.active += 1
      return
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: (): void => {
          signal?.removeEventListener('abort', abort)
          resolve()
        },
      }
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter)
        this.waiting.splice(index, 1)
        reject(verifierAbortError(signal))
      }
      this.waiting.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active -= 1
      return
    }
    next.grant()
  }
}

const verificationScheduler = new VerificationScheduler()

function workerSpawn(request: VerificationRequest): { readonly entry: string | URL; readonly options: WorkerOptions } {
  /* v8 ignore next 3 -- built-worker coverage owns the bundled path. */
  if (!import.meta.url.endsWith('.ts')) {
    return {
      entry: new URL('./worker.cjs', import.meta.url),
      options: { workerData: request, execArgv: [] },
    }
  }
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: request,
      execArgv: [],
    },
  }
}

/**
 * Verify one current generation in a fresh Worker Thread.
 * @param path - staged or competing current-generation path.
 * @param compression - configured physical encoding.
 * @param expectedId - Session id expected in the decoded header.
 * @param expectedEventCount - exact logical event count expected after decoding.
 * @param expectedPrefix - verified physical prefix; an append tail may be present and is not validated.
 * @param signal - optional cancellation for scheduler wait and Worker execution.
 * @returns stable physical identity and digest observed by the worker.
 */
export function verifyCurrentGenerationInWorker(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  expectedPrefix?: JsonlExpectedPrefix,
  signal?: AbortSignal,
): Promise<JsonlVerifiedGeneration> {
  return verificationScheduler.run(() => runVerificationWorker(
    path,
    compression,
    expectedId,
    expectedEventCount,
    expectedPrefix,
    signal,
  ), signal)
}

function runVerificationWorker(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  expectedPrefix?: JsonlExpectedPrefix,
  signal?: AbortSignal,
): Promise<JsonlVerifiedGeneration> {
  signal?.throwIfAborted()
  const request: VerificationRequest = {
    path, compression, expectedId, expectedEventCount,
    ...(expectedPrefix === undefined ? {} : { expectedPrefix }),
  }
  const { entry, options } = workerSpawn(request)
  const worker = new Worker(entry, options)
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      /* v8 ignore next -- a late error/exit races only after another terminal callback settled. */
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate().then(
        () => { reject(error) },
        (cleanup: unknown) => {
          reject(new AggregateError([error, cleanup], 'migration verifier termination failed'))
        },
      )
    }
    worker.once('message', (value: unknown) => {
      /* v8 ignore next -- a duplicate message races only after another terminal callback settled. */
      if (settled) return
      if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') {
        fail(new Error('migration verifier returned an invalid response'))
        return
      }
      const response = value as VerificationResponse
      if (!response.ok) {
        const error = new Error(response.message)
        if (response.stack !== undefined) error.stack = response.stack
        fail(error)
        return
      }
      settled = true
      cleanup()
      void worker.terminate().then(
        () => { resolve(response.result) },
        (error: unknown) => { reject(error instanceof Error ? error : new Error(String(error))) },
      )
    })
    worker.once('error', fail)
    worker.once('exit', (code) => {
      if (!settled) fail(new Error(`migration verifier exited before reporting a result (code ${code})`))
    })
    const abort = (): void => { fail(verifierAbortError(signal)) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function verifierAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error
    ? reason
    : new Error('migration verifier aborted', { cause: reason })
}
