/** Builtin image metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { retainDocumentTabs } from '../document/tab-lifetime.ts'
import { createZoomStore, type ZoomInjected, type ZoomStore } from '../zoom/store.ts'
import { ImageBody } from './ImageBody.tsx'
import { en, zh } from './locales.ts'

/** Image implementation identity, shared by metadata and the keyed slot. */
export const IMAGE_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/image'

/** File suffixes rendered by the builtin image body. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'] as const

/** Bitmap suffixes whose bytes are unreadable as text; SVG stays out because its XML source is worth reading. */
export const BINARY_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'] as const

/**
 * Describe the builtin image renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns metadata for complete image files.
 */
export function imageBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: IMAGE_BODY_ID,
    extensions: IMAGE_EXTENSIONS,
    binaryExtensions: BINARY_IMAGE_EXTENSIONS,
    priority: 'builtin',
    title,
    loading: 'bytes-complete',
    wrap: false,
  }
}

/**
 * Register the image dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarImage')
  ctx.effect(() => ctx.locale.register('sidebarImage', { zh, en }), 'document-image: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(imageBodyDefinition(() => t('title'))), 'document-image: metadata')
  const store = createZoomStore()
  const retainTab = retainDocumentTabs(ctx)
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: IMAGE_BODY_ID, locale: 'sidebarImage', store,
    inject: (_sessionId: SessionId, actions: BoundActions<ZoomStore>): ZoomInjected => ({
      retainTab: (tabId, signal) => { retainTab(tabId, signal, actions.forget) },
    }),
  }, ImageBody)), 'document-image: body')
}
