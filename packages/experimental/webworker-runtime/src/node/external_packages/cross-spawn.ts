/** Stdio MCP servers and other cross-spawn launches need a Node child process. */
import { notImplementedFail } from '../notImplementedFail.ts'

/** CommonJS interop marker for the worker loader's default import. */
export const __esModule = true

/** Refuse asynchronous cross-spawn launches without starting a shell Worker. */
export const spawn = notImplementedFail('cross-spawn', 'spawn')

/** Refuse synchronous cross-spawn launches. */
export const sync = notImplementedFail('cross-spawn', 'sync')

/** The callable package export, carrying the `spawn` and `sync` members as cross-spawn does. */
export default Object.assign(spawn, { spawn, sync })
