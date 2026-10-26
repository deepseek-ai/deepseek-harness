/** V8 imports remain loadable; native startup snapshot queries require a Node Host. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** Startup snapshot queries report the unavailable native V8 capability before throwing. */
export const startupSnapshot: Pick<typeof import('node:v8').startupSnapshot, 'isBuildingSnapshot'> = {
  isBuildingSnapshot: notImplementedFail('node:v8', 'startupSnapshot.isBuildingSnapshot'),
}

/** CommonJS interop marker consumed by lowered default imports. */
export const __esModule = true

/** CommonJS default export for the V8 member consumed by import-meta-resolve. */
export default { startupSnapshot }
