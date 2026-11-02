/**
 * Test-only client roster of the assembled viewer page.
 *
 * A served viewer page is the owner's own Web shell with the owner's client plugins; this roster is the
 * subset the viewer page specs need: the wire plugin, the Gateway, remote access, the Session/Workspace controllers,
 * the menu service, presentation plugins, and the Liveshare `./client` face, which mounts the viewer surfaces when the
 * carrier names a share. Every row is the package's own `/client` face registered as a module-table
 * factory. It must be imported only after {@link prepareViewerRemoteFaces} answered the generated
 * `/remote` faces these plugins import.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/tests/viewer-page-roster
 */

import * as apiGateway from '@deepseek-ai/dsh-api-gateway/client'
import * as apiRemoteAccess from '@deepseek-ai/dsh-api-remote-access/client'
import * as apiRemotes from '@deepseek-ai/dsh-api-remotes/client'
import * as apiSessionController from '@deepseek-ai/dsh-api-session-controller/client'
import * as apiWorkspaceController from '@deepseek-ai/dsh-api-workspace-controller/client'
import * as clientConnection from '@deepseek-ai/dsh-client-connection/client'
import * as clientFileUpload from '@deepseek-ai/dsh-client-file-upload/client'
import * as clientLocale from '@deepseek-ai/dsh-client-locale/client'
import * as clientModules from '@deepseek-ai/dsh-client-modules/client'
import * as clientResources from '@deepseek-ai/dsh-client-resources/client'
import * as clientShortcuts from '@deepseek-ai/dsh-client-shortcuts/client'
import * as uiAttachment from '@deepseek-ai/dsh-client-ui-attachment/client'
import * as uiChat from '@deepseek-ai/dsh-client-ui-chat/client'
import * as uiContextMenu from '@deepseek-ai/dsh-client-ui-context-menu/client'
import * as uiConversation from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as uiDeliverables from '@deepseek-ai/dsh-client-ui-deliverables/client'
import * as uiFileDrag from '@deepseek-ai/dsh-client-ui-file-drag/client'
import * as uiLayout from '@deepseek-ai/dsh-client-ui-layout/client'
import * as uiRenderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as uiSession from '@deepseek-ai/dsh-client-ui-session/client'
import * as uiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as uiSidebar from '@deepseek-ai/dsh-client-ui-sidebar/client'
import * as uiSidebarRight from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import * as uiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
import * as uiTool from '@deepseek-ai/dsh-client-ui-tool/client'
import * as uiTrajectory from '@deepseek-ai/dsh-client-ui-trajectory/client'
import * as uiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/client'
import * as typertRegistry from '@deepseek-ai/dsh-typert-registry/client'
import * as liveshare from '../src/client/index.ts'

/** One module-table row: the entry id the Loader creates, and that plugin's client exports. */
export interface ViewerPageRosterRow {
  readonly id: string
  readonly exports: Readonly<Record<string, unknown>>
}

/** Entry id of the module-system bootstrap whose exports the facade hands to the module system. */
export const VIEWER_PAGE_BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'

/** The viewer page roster; Cordis composes these entries by service injection, so order is irrelevant. */
export const VIEWER_PAGE_ROSTER: readonly ViewerPageRosterRow[] = [
  { id: '@deepseek-ai/dsh-typert-registry', exports: typertRegistry },
  { id: '@deepseek-ai/dsh-experimental-liveshare', exports: liveshare },
  { id: VIEWER_PAGE_BOOTSTRAP_ID, exports: clientModules },
  { id: '@deepseek-ai/dsh-client-connection', exports: clientConnection },
  { id: '@deepseek-ai/dsh-api-gateway', exports: apiGateway },
  { id: '@deepseek-ai/dsh-api-remote-access', exports: apiRemoteAccess },
  { id: '@deepseek-ai/dsh-api-remotes', exports: apiRemotes },
  { id: '@deepseek-ai/dsh-api-session-controller', exports: apiSessionController },
  { id: '@deepseek-ai/dsh-api-workspace-controller', exports: apiWorkspaceController },
  { id: '@deepseek-ai/dsh-client-file-upload', exports: clientFileUpload },
  { id: '@deepseek-ai/dsh-client-locale', exports: clientLocale },
  { id: '@deepseek-ai/dsh-client-resources', exports: clientResources },
  { id: '@deepseek-ai/dsh-client-shortcuts', exports: clientShortcuts },
  { id: '@deepseek-ai/dsh-client-ui-renderer', exports: uiRenderer },
  { id: '@deepseek-ai/dsh-client-ui-theme', exports: uiTheme },
  { id: '@deepseek-ai/dsh-client-ui-settings', exports: uiSettings },
  { id: '@deepseek-ai/dsh-client-ui-layout', exports: uiLayout },
  { id: '@deepseek-ai/dsh-client-ui-session', exports: uiSession },
  { id: '@deepseek-ai/dsh-client-ui-sidebar', exports: uiSidebar },
  { id: '@deepseek-ai/dsh-client-ui-conversation', exports: uiConversation },
  { id: '@deepseek-ai/dsh-client-ui-chat', exports: uiChat },
  { id: '@deepseek-ai/dsh-client-ui-context-menu', exports: uiContextMenu },
  { id: '@deepseek-ai/dsh-client-ui-tool', exports: uiTool },
  { id: '@deepseek-ai/dsh-client-ui-attachment', exports: uiAttachment },
  { id: '@deepseek-ai/dsh-client-ui-file-drag', exports: uiFileDrag },
  { id: '@deepseek-ai/dsh-client-ui-sidebar-right', exports: uiSidebarRight },
  { id: '@deepseek-ai/dsh-client-ui-trajectory', exports: uiTrajectory },
  { id: '@deepseek-ai/dsh-client-ui-deliverables', exports: uiDeliverables },
  { id: '@deepseek-ai/dsh-client-ui-workspace', exports: uiWorkspace },
]
