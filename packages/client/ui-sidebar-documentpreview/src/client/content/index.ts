/** Register shared content rendering with direct navigation inputs. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import { ContentPreview } from './ContentPreview.tsx'
import { ContentTitle } from './ContentTitle.tsx'
import { contentFace, type ContentFaceSources } from './face.ts'
import { CONTENTPREVIEW_ID, ContentPreviewService } from './service.ts'
import { createContentPreviewStore } from './store.ts'

/** The copy namespace the body and the fallback title read. */
const NS = 'sidebarDocumentPreview'

/**
 * Provide direct content navigation and register its tab body and title.
 * @param ctx - context carrying the tab registry, the resource model, the renderer registry, slots, and copy.
 * @param retainTab - retains a content tab's view state until its record ends or the plugin is disposed.
 */
export function apply(ctx: Context, retainTab: ContentFaceSources['retainTab']): void {
  const t = ctx.locale.bind(NS)
  const service = new ContentPreviewService(ctx.sidebarRight, () => t('content.title'))
  const disposeService = ctx.reflect.provide('contentPreviews', service)
  ctx.effect(() => disposeService, 'ui-sidebar-documentpreview: content service')
  ctx.effect(() => ctx.sidebarRightTabs.register(service.definition()), 'ui-sidebar-documentpreview: content type')

  const previews = ctx.documentPreviews
  const face = contentFace({
    mediaTypeCandidates: mediaType => previews.mediaTypeCandidates(mediaType),
    hooks: { documentPreviews: { getSnapshot: previews.getSnapshot, subscribe: previews.subscribe } },
    retainTab,
  })
  const store = createContentPreviewStore()
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: CONTENTPREVIEW_ID, locale: NS, store,
      children: { 'sidebar.right.tab.content.actions': { kind: 'list', scope: 'session' } },
      inject: face,
    },
    ContentPreview,
  )), 'ui-sidebar-documentpreview: content body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: CONTENTPREVIEW_ID },
    ContentTitle,
  )), 'ui-sidebar-documentpreview: content title')
}
