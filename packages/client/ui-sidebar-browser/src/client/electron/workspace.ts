/** Resolve CWD-keyed Electron storage after the authoritative Workspace list has arrived. */
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'

/**
 * Use the Workspace's canonical CWD, not its record id; ungrouped Sessions remain isolated.
 * @param source - authoritative Workspace membership.
 * @param sessionId - owning DSH Session.
 * @param signal - guest initialization lifetime.
 * @returns the storage account for this occurrence.
 */
export async function browserWorkspace(source: WorkspaceSource, sessionId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (source.getSnapshot().phase !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        stop()
        const reason: unknown = signal.reason
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller-owned AbortSignal reason.
        reject(reason)
      }
      const stop = source.subscribe(() => {
        if (source.getSnapshot().phase !== 'ready') return
        stop()
        signal.removeEventListener('abort', abort)
        resolve()
      })
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  signal.throwIfAborted()
  const workspace = source.getSnapshot().items.find(item => item.sessionIds.some(id => id === sessionId))
  return workspace === undefined ? `session:${sessionId}` : `cwd:${workspace.path}`
}
