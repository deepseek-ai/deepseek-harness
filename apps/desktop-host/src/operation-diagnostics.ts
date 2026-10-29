/** Bounded delivery of management facts to the shell which owns durable diagnostics. */
import type { Context } from '@deepseek-ai/cordis'
import { parsePluginOperationRecord, type PluginOperationRecord, type PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'

/**
 * Observe manager operations after Host startup, with bounded concurrent IPC deliveries.
 * @param ctx - Context owning the subscription and its pending deliveries.
 * @param send - IPC transport promise which settles when delivery succeeds or fails.
 * @param maxPending - Maximum number of outstanding deliveries; excess events are counted and omitted.
 * @param runId - Host lifetime identity announced before profile startup.
 */
export function installOperationDiagnostics(
  ctx: Context, send: (record: PluginOperationRecord) => Promise<void>, maxPending: number, runId: PluginOperationRunId,
): void {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new RangeError('Invalid diagnostic delivery budget')
  const pending = new Set<Promise<void>>()
  let dropped = 0
  let closed = false
  ctx.on('plugin-manager/operation', (operation) => {
    if (closed || pending.size >= maxPending) { dropped++; return }
    const record = parsePluginOperationRecord({ runId, operation, transportDropped: dropped })
    if (record === undefined) { dropped++; return }
    const delivery = Promise.resolve().then(async () => {
      try { await send(record) }
      catch (_error) { dropped++ /* IPC failure does not change the management operation. */ }
    })
    pending.add(delivery)
    void delivery.then(() => { pending.delete(delivery) })
  })
  ctx.effect(() => async () => {
    closed = true
    await Promise.allSettled(pending)
  })
}
