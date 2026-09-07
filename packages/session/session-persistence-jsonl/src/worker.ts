/** Worker entry for current-generation physical and logical verification. */

import { parentPort, workerData } from 'node:worker_threads'
import { verifyJsonlCurrentGeneration } from './generation.ts'
import type { JsonlExpectedPrefix } from './generation.ts'
import type { JsonlCompression } from './format.ts'

interface VerificationRequest {
  readonly path: string
  readonly compression: JsonlCompression
  readonly expectedId: string
  readonly expectedEventCount: number
  readonly expectedPrefix?: JsonlExpectedPrefix
}

function parseRequest(value: unknown): VerificationRequest {
  if (typeof value !== 'object' || value === null) throw new Error('migration verifier request must be an object')
  const request = value as Partial<VerificationRequest>
  if (typeof request.path !== 'string'
    || request.compression !== 'none' && request.compression !== 'zstd'
    || typeof request.expectedId !== 'string'
    || !Number.isSafeInteger(request.expectedEventCount)
    || (request.expectedEventCount as number) < 0
    || request.expectedPrefix !== undefined
      && (!Number.isSafeInteger(request.expectedPrefix.bytes)
        || request.expectedPrefix.bytes < 0
        || !/^[0-9a-f]{64}$/.test(request.expectedPrefix.digest))) {
    throw new Error('migration verifier request is malformed')
  }
  return request as VerificationRequest
}

if (parentPort === null) throw new Error('migration verifier requires a parent port')
const port = parentPort

const request = parseRequest(workerData)

async function verify(): Promise<void> {
  try {
    const result = await verifyJsonlCurrentGeneration(
      request.path,
      request.compression,
      request.expectedId,
      request.expectedEventCount,
      request.expectedPrefix,
    )
    port.postMessage({ ok: true, result })
  } catch (error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error))
    port.postMessage({ ok: false, message: failure.message, stack: failure.stack })
  } finally {
    port.close()
  }
}

void verify()
