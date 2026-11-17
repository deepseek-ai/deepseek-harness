/** Selected-result subscriptions retain no history-sized Client cache. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionToolResultValue } from '../types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Observe one result until the inspector releases it; undefined denotes unavailable. */
export type WatchToolResult = (seq: number, publish: (value: JsonValue | undefined) => void) => () => void

/**
 * Bind an ephemeral inspector stream to one Session.
 * @param remote - Generated Remote transport and reconnecting stream owner.
 * @param sessionId - Session inspected by this view.
 * @param report - Diagnostic sink for unavailable transport and teardown failures.
 * @returns Subscription factory; closing a subscription releases its selected value.
 */
export function createToolResultWatcher(
  remote: Pick<ClientRemote, '$stream' | 'toolResults'>,
  sessionId: SessionId,
  report: (error: unknown) => void,
): WatchToolResult {
  return (seq, publish) => {
    const lifetime = { stopped: false }
    const clear = (): void => { if (!lifetime.stopped) publish(undefined) }
    const stream = remote.$stream<SessionToolResultValue>({
      name: 'live tool result',
      open: signal => remote.toolResults.watch({ sessionId, seq }, signal),
      ended: () => new Error('live tool result stream ended'),
      carrierFailed: clear,
    })
    void (async () => {
      try {
        for await (const frame of stream) {
          if (lifetime.stopped) return
          frame.accept()
          publish(frame.value.available ? frame.value.value : undefined)
        }
      } catch (error: unknown) {
        if (!lifetime.stopped) { clear(); report(error) }
      } finally {
        clear()
      }
    })()
    return () => {
      lifetime.stopped = true
      void stream.dispose().catch(report)
    }
  }
}
