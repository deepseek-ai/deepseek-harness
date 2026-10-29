/**
 * Browser entry of the forge panel: the sidebar tab, the changes view, the
 * header button, the worktree option and creation card, and their Remote.
 */

import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-experimental-client-ui-forge/remote'
import { mountForgePanel } from './mount.ts'

export { inject } from './mount.ts'
export type { ForgePanelKey } from './locales.ts'
export type { ChangeRequestActions, ChangeRequestCardProps } from './ChangeRequestCard.tsx'
export type { ChangesParams, ChangesSource, ChangesTarget } from './changes-address.ts'
export type { ChangesTabInjected, ChangesTabProps } from './ChangesTab.tsx'
export type { ChangesTabTitleProps } from './ChangesTabTitle.tsx'
export type { DiffFileAction, DiffFileProps, DiffFileText } from './DiffFile.tsx'
export type { LocalChangesCardProps } from './LocalChangesCard.tsx'
export type { ForgeTabInjected, ForgeTabProps } from './ForgeTab.tsx'
export type { HeaderButtonInjected, HeaderButtonProps } from './HeaderButton.tsx'
export type { WorktreeProgressInjected, WorktreeProgressProps } from './WorktreeProgress.tsx'
export type { WorktreeToggleInjected, WorktreeToggleProps } from './WorktreeToggle.tsx'
export type { ActionNotice, NoticeOptions, PanelSnapshot } from './source.ts'

/**
 * Mount the forge panel Remote and its UI.
 * @param ctx - browser plugin context.
 * @returns the disposer that withdraws the UI, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountForgePanel(ctx, remote)
}
