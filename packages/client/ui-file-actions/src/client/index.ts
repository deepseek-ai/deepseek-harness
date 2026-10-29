/** Original-file actions independent of menu or image component ownership. */
import { IconCopyOutlineRegular, IconDownloadOutlineRegular, IconSaveOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { DesktopFileActions, FileActions } from '../types.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { registerFileMenus } from './context-menus.tsx'
import { zh, en, ja, es, fr, de, ru, pt, type FileActionKey } from './locales.ts'
import { BrowserFileActions } from './files.ts'

export type { FileActions, FileActionSource, FileSaveResult } from '../types.ts'
declare module '@deepseek-ai/cordis' {
  interface Context { /** Original-file saving and image clipboard commands. */ fileActions: FileActions }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Original-file action labels and feedback. */
    fileActions: FileActionKey
  }
}
/** The native adapter is optional; Web uses its own download and save capabilities. */
export const inject = []
/** @param ctx - plugin-owned Client context. */
export function apply(ctx: Context): void {
  const desktop = (window as Window & { dshDesktop?: { fileActions?: DesktopFileActions } }).dshDesktop?.fileActions
  const actions = new BrowserFileActions(desktop)
  ctx.provide('fileActions', actions)
  ctx.effect(() => () => { actions.dispose() }, 'file actions: lifetime')
  ctx.inject(['contextMenus', 'slots', 'locale', 'remote', 'remote.workspaceFiles', 'remote.session'], (child) => {
    child.effect(() => child.locale.register('fileActions', { zh, en, ja, es, fr, de, ru, pt }), 'file actions: locale')
    child.slots.inject('contextMenu.icon', function* () {
      for (const [key, Icon] of Object.entries({
        'file-actions.copy': IconCopyOutlineRegular, 'file-actions.download': IconDownloadOutlineRegular,
        'file-actions.save': IconSaveOutlineRegular,
      })) yield child.slots.register({ name: 'contextMenu.icon', key }, Icon)
    })
    registerFileMenus(child, actions, child.locale.bind('fileActions'))
  })
}
