/** Office conversion reads and settlements bound to the renderer's declared store. */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionFile } from '../rpc.ts'
import type { ReadOfficeDocument } from './cache.ts'
import type { OfficeStore } from './store.ts'

/** Conversion loading callback supplied to the Office body through Slot injection. */
export interface OfficeLoadInjected {
  /**
   * Read one conversion revision; cancellation suppresses its store writes and version report.
   * @param tabId - owning tab.
   * @param revision - requested content revision.
   * @param file - addressed Session and source path.
   * @param signal - request lifetime, cancelled on replacement, unmount, or tab closure.
   * @param loaded - report the displayed source version to the document owner.
   * @param failed - report a failed load to the document owner.
   */
  readonly load: (
    tabId: TabId,
    revision: number,
    file: SessionFile,
    signal: AbortSignal,
    loaded: (version: string) => void,
    failed: () => void,
  ) => void
}

/**
 * Bind Office reads to store actions without exposing Remote work to the component.
 * @param read - authorized conversion reader, including Client cache reuse.
 * @param describeFailure - localized conversion or source-access failure text.
 * @returns Slot inject factory; the file address supplies the read's Session authority.
 */
export function officeFace(
  read: ReadOfficeDocument,
  describeFailure: (failure: RemoteFailure | { readonly message: string }) => string,
): (sessionId: SessionId, actions: BoundActions<OfficeStore>) => OfficeLoadInjected {
  return (_sessionId, actions) => ({
    load: (tabId, revision, file, signal, loaded, failed) => {
      if (signal.aborted) return
      actions.loading(tabId, revision)
      void read(file, signal).then((result) => {
        if (signal.aborted) return
        if (result.ok) {
          actions.complete(tabId, revision, result.value)
          loaded(result.value.version)
        } else {
          actions.failed(tabId, revision, { code: result.error.code, message: describeFailure(result.error) })
          failed()
        }
      }, (error: unknown) => {
        if (!signal.aborted) {
          actions.failed(tabId, revision, {
            code: 'gateway/internal', message: describeFailure({ message: error instanceof Error ? error.message : String(error) }),
          })
          failed()
        }
      })
    },
  })
}
