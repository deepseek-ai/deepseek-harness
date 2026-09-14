/**
 * The preview's asynchronous half: reading pages into the store.
 *
 * The component never awaits anything. It asks for a page and this face performs
 * the read and writes the outcome through the store's own actions — the
 * Slot-standard `inject` form, so the write set stays the store's. The session
 * the read runs under comes from the file's address, not from the slot's
 * session: the address is the read's whole authority.
 *
 * A tab's pages are one file version walked from the first line. Dropping them
 * — a reload, or a page of a newer version arriving past the first line, which
 * restarts the walk — retires every read still in flight for the tab: a
 * settlement from before the drop writes nothing. Cleanup rides the owner's
 * `signal`, armed once per tab by its first read: the abort forgets the tab's
 * bucket and this bookkeeping, a request is not made for a record that already
 * ended, and a settlement arriving after the record is gone has nothing left to
 * write to. A tab that never read has no bucket to forget.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReadDocumentBytes, ReadWorkspaceFilePage, SessionFile } from './rpc.ts'
import { documentFileBytes } from './rpc.ts'
import type { TextStore } from './store.ts'
import type { DocumentLoadMode } from './document/registry.ts'

/** The preview's injected business face, as the body receives it. */
export interface TextInjected {
  /**
   * Read one page into the store. A page of a newer file version than the pages
   * held, arriving past the first line, is not kept: the tab's pages are dropped
   * and the first page read again. The tab's first read arms the abort listener
   * that forgets its bucket when the record ends.
   * @param tabId - the tab being drawn.
   * @param file - the session and workspace path the tab's address names.
   * @param offset - 1-based line the page starts at.
   * @param signal - the tab record's lifetime.
   * @param observedVersion - metadata version observed at read start.
   */
  readonly loadPage: (tabId: TabId, file: SessionFile, offset: number, signal: AbortSignal, observedVersion?: string) => void
  /**
   * Drop every page and read the first one again, for a file the Host reports
   * changed. The view is kept, so the reader stays where they were; a page read
   * still in flight writes nothing when it settles.
   * @param tabId - the tab being drawn.
   * @param file - the session and workspace path the tab's address names.
   * @param signal - the tab record's lifetime.
   * @param observedVersion - metadata version observed at read start.
   */
  readonly reloadPages: (tabId: TabId, file: SessionFile, signal: AbortSignal, observedVersion?: string) => void
  /**
   * Read the complete file for a whole-file renderer.
   * @param tabId - owning tab.
   * @param file - the session and workspace path the tab's address names.
   * @param signal - tab lifetime.
   * @param observedVersion - metadata version observed at read start.
   */
  readonly loadAll: (tabId: TabId, file: SessionFile, signal: AbortSignal, observedVersion?: string) => void
  /**
   * Discard the old complete result and read again.
   * @param tabId - owning tab.
   * @param file - the session and workspace path the tab's address names.
   * @param signal - tab lifetime.
   * @param observedVersion - metadata version observed at read start.
   */
  readonly reloadAll: (tabId: TabId, file: SessionFile, signal: AbortSignal, observedVersion?: string) => void
}

/**
 * What the face remembers of one tab: the read generation a settlement must
 * match, and the version of the pages held. Created by the tab's first read,
 * which also arms the one abort listener that forgets the tab.
 */
interface TabReads {
  generation: number
  version: string | undefined
  mode: DocumentLoadMode
}

/**
 * Bind the preview's face to one paged read and one complete-byte read.
 * @param read - the bound `workspaceFiles.read` call.
 * @param readAll - ordinary complete-byte Remote read.
 * @returns the Slot `inject` factory: bound actions in, face out. The slot's session id is unused because the address carries its own.
 */
export function textFace(
  read: ReadWorkspaceFilePage,
  readAll: ReadDocumentBytes,
): (sessionId: SessionId, actions: BoundActions<TextStore>) => TextInjected {
  return (_sessionId: SessionId, actions: BoundActions<TextStore>): TextInjected => {
    const tabs = new Map<TabId, TabReads>()
    // Reached with a live signal only: the record's end forgets the tab's
    // bucket and this bookkeeping in one listener, however often its body mounts.
    const readsOf = (tabId: TabId, signal: AbortSignal): TabReads => {
      const held = tabs.get(tabId)
      if (held !== undefined) return held
      const created: TabReads = { generation: 0, version: undefined, mode: 'text-pages' }
      tabs.set(tabId, created)
      signal.addEventListener('abort', () => {
        tabs.delete(tabId)
        actions.forget(tabId)
      }, { once: true })
      return created
    }
    const modeOf = (tabId: TabId, signal: AbortSignal, mode: DocumentLoadMode): TabReads => {
      const reads = readsOf(tabId, signal)
      if (reads.mode !== mode) {
        reads.mode = mode
        reads.generation++
        reads.version = undefined
        actions.reset(tabId)
      }
      return reads
    }
    const loadPage = (tabId: TabId, file: SessionFile, offset: number, signal: AbortSignal, observedVersion?: string): void => {
      if (signal.aborted) return
      const reads = modeOf(tabId, signal, 'text-pages')
      const { generation } = reads
      actions.loading(tabId, 'text-pages', observedVersion)
      void read(file.sessionId, file.path, offset, signal).then((result) => {
        if (signal.aborted || reads.generation !== generation) return
        if (!result.ok) {
          actions.failed(tabId, result.error)
          return
        }
        // Pages of two versions never meet: a newer file past the first line
        // restarts the walk from line 1, where the store adopts the new version.
        if (offset !== 1 && reads.version !== undefined && result.value.version !== reads.version) {
          restart(tabId, file, signal, observedVersion)
          return
        }
        reads.version = result.value.version
        actions.page(tabId, result.value)
      })
    }
    const loadAll = (tabId: TabId, file: SessionFile, signal: AbortSignal, observedVersion?: string): void => {
      if (signal.aborted) return
      const reads = modeOf(tabId, signal, 'bytes-complete')
      const { generation } = reads
      actions.loading(tabId, 'bytes-complete', observedVersion)
      void readAll(file, signal).then((result) => {
        if (signal.aborted || reads.generation !== generation) return
        if (!result.ok) {
          actions.failed(tabId, result.error)
          return
        }
        let file
        try {
          file = documentFileBytes(result.value)
        } catch (error) {
          actions.failed(tabId, Object.assign(
            new Error('document file byte response has malformed base64 data', { cause: error }),
            { name: 'RemoteError', isDSHRemoteError: true as const, code: 'gateway/internal' as const, details: {} },
          ))
          return
        }
        reads.version = file.version
        actions.complete(tabId, file)
      })
    }
    const restart = (
      tabId: TabId, file: SessionFile, signal: AbortSignal, observedVersion?: string, mode: DocumentLoadMode = 'text-pages',
    ): void => {
      if (signal.aborted) return
      const reads = readsOf(tabId, signal)
      reads.generation += 1
      reads.version = undefined
      actions.reset(tabId)
      if (mode === 'text-pages') loadPage(tabId, file, 1, signal, observedVersion)
      else loadAll(tabId, file, signal, observedVersion)
    }
    return {
      loadPage, reloadPages: restart, loadAll,
      reloadAll: (tabId, file, signal, observedVersion) => { restart(tabId, file, signal, observedVersion, 'bytes-complete') },
    }
  }
}
