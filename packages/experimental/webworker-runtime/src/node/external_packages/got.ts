/** Node HTTP product telemetry is unavailable in the browser preview. */
import { notImplementedFail } from '../notImplementedFail.ts'

/** CommonJS interop marker for the worker loader's default import. */
export const __esModule = true

/** Reject product telemetry HTTP requests without opening a connection. */
const got = { post: notImplementedFail('got', 'post') }

export default got
