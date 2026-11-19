/** Register shared content rendering with direct navigation inputs. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import { ContentPreview, ContentViewer } from './ContentPreview.tsx'
import { ContentTitle } from './ContentTitle.tsx'
import { contentFace, type ContentFaceSources } from './face.ts'
import { createContentPreviewStore } from './store.ts'

/** Implementation identity of the shared content tab. */
export const CONTENTPREVIEW_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/content'

/** The copy namespace the body and the fallback title read. */
const NS = 'sidebarDocumentPreview'

/**
 * Register the content tab renderer and title.
 * @param ctx - context carrying the tab registry, the resource model, the renderer registry, slots, and copy.
 * @param retainTab - retains a content tab's view state until its record ends or the plugin is disposed.
 */
export function apply(ctx: Context, retainTab: ContentFaceSources['retainTab']): void {
  const t = ctx.locale.bind(NS)
  const previews = ctx.documentPreviews
  const face = contentFace({
    mediaTypeCandidates: mediaType => previews.mediaTypeCandidates(mediaType),
    hooks: { documentPreviews: { getSnapshot: previews.getSnapshot, subscribe: previews.subscribe } },
    retainTab,
  })
  ctx.effect(() => ctx.slots.registerFactory({
    name: 'sidebar.right.content.preview', scope: 'session', locale: NS,
    store: createContentPreviewStore(), inject: face,
  }, ContentViewer), 'ui-sidebar-documentpreview: shared content viewer')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: CONTENTPREVIEW_ID },
    ContentPreview,
  )), 'ui-sidebar-documentpreview: content body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: CONTENTPREVIEW_ID },
    ContentTitle,
  )), 'ui-sidebar-documentpreview: content title')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CONTENTPREVIEW_ID, kind: 'content', priority: 'builtin',
    patterns: ['dsh-resource://content-preview/**'], title: () => t('content.title'),
  }), 'ui-sidebar-documentpreview: content type')
}
