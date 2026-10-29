/** Node REPL imports are available for packaging; starting a native REPL requires a Node Host. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** REPL construction is unavailable in the browser worker. */
export const start: typeof import('node:repl').start = notImplementedFail('node:repl', 'start')

/** CommonJS interop marker consumed by the Worker module loader. */
export const __esModule = true

/** CommonJS export for the REPL member used by the Node PTC evaluator. */
export default { start } satisfies Partial<typeof import('node:repl')>
