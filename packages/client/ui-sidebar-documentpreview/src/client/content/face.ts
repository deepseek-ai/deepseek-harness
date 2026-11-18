/**
 * The content preview's injected faces: view-state writes that arm the
 * per-tab forget, and renderer lookup by media type.
 *
 * A tab's first view write retains the tab through the plugin-scoped
 * `retainTab`; the tab record's abort forgets the tab's bucket, and the
 * plugin's disposal removes the listener. A tab that never wrote has no bucket.
 */
import type { BoundActions, ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DocumentLoadMode, DocumentPreviewDefinition } from '../index.ts'
import type { ContentPreviewStore } from './store.ts'

/** A renderer that accepts media-type content; the registry rejects media types on renderer-owned loading. */
export type MediaTypeRenderer = DocumentPreviewDefinition & { readonly loading: Exclude<DocumentLoadMode, 'renderer'> }

/** The body's injected face. */
export interface ContentPreviewInjected {
  /**
   * Record a renderer choice.
   * @param tabId - owning tab. @param signal - tab record lifetime. @param rendererId - chosen implementation.
   */
  readonly select: (tabId: TabId, signal: AbortSignal, rendererId: string) => void
  /** Switch line wrap. @param tabId - owning tab. @param signal - tab record lifetime. */
  readonly toggleWrap: (tabId: TabId, signal: AbortSignal) => void
  /** Record the body's scroll offset. @param tabId - owning tab. @param signal - tab record lifetime. @param scrollTop - offset in px. */
  readonly scroll: (tabId: TabId, signal: AbortSignal, scrollTop: number) => void
  /**
   * Renderers accepting a media type, in automatic-selection order.
   * @param mediaType - content media type.
   * @returns the matching implementations.
   */
  readonly mediaTypeCandidates: (mediaType: string) => readonly MediaTypeRenderer[]
  /** Renderer registrations observed by the body. */
  readonly hooks: {
    readonly documentPreviews: ObservableSnapshot<readonly DocumentPreviewDefinition[]>
  }
}

/** What the body face reads from the plugin's services. */
export interface ContentFaceSources {
  /** The renderer registry's media-type ranking. @param mediaType - content media type. @returns matching implementations. */
  readonly mediaTypeCandidates: (mediaType: string) => readonly DocumentPreviewDefinition[]
  readonly hooks: ContentPreviewInjected['hooks']
  /**
   * Retain a tab's view state until its record ends or the plugin is disposed.
   * @param tabId - owning tab. @param signal - tab record lifetime. @param forget - the store's forget action.
   */
  readonly retainTab: (tabId: TabId, signal: AbortSignal, forget: (tabId: TabId) => void) => void
}

/**
 * Bind the body face to the plugin's services.
 * @param sources - renderer lookup, its observable registrations, and tab retention.
 * @returns the Slot `inject` factory: bound actions in, face out.
 */
export function contentFace(
  sources: ContentFaceSources,
): (_sessionId: unknown, actions: BoundActions<ContentPreviewStore>) => ContentPreviewInjected {
  return (_sessionId, actions) => {
    const live = (tabId: TabId, signal: AbortSignal): boolean => {
      if (signal.aborted) return false
      sources.retainTab(tabId, signal, actions.forget)
      return true
    }
    return {
      select: (tabId, signal, rendererId) => { if (live(tabId, signal)) actions.selected(tabId, rendererId) },
      toggleWrap: (tabId, signal) => { if (live(tabId, signal)) actions.toggledWrap(tabId) },
      scroll: (tabId, signal, scrollTop) => { if (live(tabId, signal)) actions.scrolled(tabId, scrollTop) },
      // `DocumentPreviewRegistry.register` already rejects `mediaTypes` with
      // `loading: 'renderer'`; this filter rechecks that invariant to narrow the type to `MediaTypeRenderer`.
      mediaTypeCandidates: mediaType => sources.mediaTypeCandidates(mediaType)
        .filter((definition): definition is MediaTypeRenderer => definition.loading !== 'renderer'),
      hooks: sources.hooks,
    }
  }
}
