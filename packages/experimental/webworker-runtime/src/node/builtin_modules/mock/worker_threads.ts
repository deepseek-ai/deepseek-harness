/**
 * `node:worker_threads` stub. Nested workers are unsupported, so the workflow
 * plugin body mounts and fails on use. The
 * thread-identity values are real: they say "this is the main thread", which is
 * what the worker host is from the tree's point of view.
 */
import { notImplementedFail } from '../../notImplementedFail.ts'

const MODULE = 'node:worker_threads'

/** Worker-thread construction (unavailable). */
export const Worker: typeof import('node:worker_threads').Worker = notImplementedFail(MODULE, 'Worker')

/** The host tree runs on the worker's main thread. */
export const isMainThread = true

/** Thread id of the worker's main thread. */
export const threadId = 0

/** No parent port exists, which Node reports as `null` outside a worker thread. */
export const parentPort = null

/** No thread data was handed in. */
export const workerData = undefined

/** Channel construction (unavailable). */
export const MessageChannel: typeof import('node:worker_threads').MessageChannel = notImplementedFail(MODULE, 'MessageChannel')

/** Port construction (unavailable). */
export const MessagePort: typeof import('node:worker_threads').MessagePort = notImplementedFail(MODULE, 'MessagePort')

/** Object transfer marking (unavailable). */
export const markAsUntransferable: typeof import('node:worker_threads').markAsUntransferable
  = notImplementedFail(MODULE, 'markAsUntransferable')

/** Port receiving on a message channel (unavailable). */
export const receiveMessageOnPort: typeof import('node:worker_threads').receiveMessageOnPort
  = notImplementedFail(MODULE, 'receiveMessageOnPort')

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** The `node:worker_threads` declarations this module stands in for. */
type NodeFace = Partial<typeof import('node:worker_threads')>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  Worker, isMainThread, threadId, parentPort, workerData, MessageChannel, MessagePort,
  markAsUntransferable, receiveMessageOnPort,
} satisfies NodeFace
