/**
 * Connectors, browser half: the Plugins page tab that lists the official connectors, installs a missing one through
 * the page's install dialog, and opens an installed one's page, with the section and the add action that edit the
 * custom MCP servers through the Host's `connectors` Remote.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-client-ui-connectors/remote'
import type { ConnectorsActionOwnerProps } from './ConnectorsTab.tsx'
import type { CustomServersOwnerProps } from './CustomServersSection.tsx'
import type { ConnectorsLocaleKey } from './locales.ts'
import { mountConnectors } from './mount.ts'

export { inject } from './mount.ts'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface LocaleNamespaceMap {
    /** Connectors tab copy. */
    connectors: ConnectorsLocaleKey
  }
  interface SlotMap {
    /**
     * The Connectors tab's actions at the end of its first heading's row, shown while the tab shows its lists; this
     * plugin registers the button that opens a new custom MCP server's form there once the manager's Remote exists.
     * The tab passes the change of its view.
     */
    'connectors.actions': { kind: 'list'; scope: 'root'; owner: ConnectorsActionOwnerProps }
    /**
     * The Connectors tab's section below the official connectors; this plugin registers the custom MCP servers
     * section there once the manager's Remote exists. The tab passes the section's view and shows only the section,
     * under the Plugins page's crumb, while the view is a server's page; without an entry the tab shows only the
     * official connectors.
     */
    'connectors.custom': { kind: 'single'; scope: 'root'; owner: CustomServersOwnerProps }
  }
}

/**
 * Contribute the Connectors tab, its custom servers section, and the section's add action for this plugin's lifetime.
 * @param ctx - the browser plugin context.
 * @returns the disposer that withdraws the section and its add action before the generated Remote.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountConnectors(ctx, remote)
}
