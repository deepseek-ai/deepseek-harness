/** Navigate to transient content without retaining a separate content cache. */
import type { Context } from '@deepseek-ai/cordis'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ContentPreviews, ContentPreviewOptions, PreviewContent } from './contract.ts'

/** Implementation identity of the shared content tab. */
export const CONTENTPREVIEW_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/content'

/** Shared content tab kind. */
export const CONTENTPREVIEW_KIND = 'content'

/** Direct content navigation; the sidebar owns input lifetime. */
export class ContentPreviewService implements ContentPreviews {
  /** @param sidebar - shared navigation controller. @param fallbackTitle - title after transient input expires. */
  constructor(private readonly sidebar: Pick<Context['sidebarRight'], 'openResource'>, private readonly fallbackTitle: () => string) {}

  open(content: PreviewContent, options: ContentPreviewOptions): void {
    const key = options.key ?? randomUUID()
    const address = `dsh-resource://content-preview/${encodeURIComponent(key)}`
    this.sidebar.openResource(address, {
      ...options.destination === undefined ? {} : { destination: options.destination },
      params: { previewContent: content, previewTitle: options.title },
    })
  }

  /** Build the transient preview tab definition.
   * @returns the tab definition for direct content navigation.
   */
  definition(): SidebarRightTabDefinition {
    return {
      id: CONTENTPREVIEW_ID, kind: CONTENTPREVIEW_KIND, priority: 'builtin',
      patterns: ['dsh-resource://content-preview/**'], title: this.fallbackTitle,
    }
  }
}
