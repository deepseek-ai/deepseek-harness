/** Loader lifecycle operations shared by live graph reconciliation and code replacement. */
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

/**
 * Release a runtime before clearing its entry fiber so Loader refresh can import new code.
 * Registry deletion prevents Loader from treating replacement as a user disable.
 * @param entry - Entry retained for code replacement.
 */
export async function tearDownEntryFiber(entry: Entry): Promise<void> {
  const fiber = entry.fiber
  if (fiber === undefined) return
  const runtime = fiber.runtime
  /* v8 ignore next -- Loader entries own plugin fibers; only the root context has a null runtime. */
  if (runtime !== null) entry.ctx.registry.delete(runtime.callback)
  while (fiber.inertia !== undefined) await fiber.inertia
  delete entry.fiber
}
