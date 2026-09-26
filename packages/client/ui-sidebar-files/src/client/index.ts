/**
 * Browser half: register `files` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat and the chip title into
 * the keyed `sidebar.right.pane.tab.title` seat, both under the type's `id`.
 *
 * The file split is this package's layering: what the type IS
 * (`definition.tsx`), what it keeps (`store.ts`), how it lists (`face.ts`), what
 * it draws (`FilesBody.tsx`, `FilesTitle.tsx`), what it says (`locales.ts`),
 * and this module, which only wires them together.
 */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { FILES_ID, filesDefinition } from './definition.tsx'
import { createList, createWatch, filesFace } from './face.ts'
import { FilesBody } from './FilesBody.tsx'
import { FilesTitle } from './FilesTitle.tsx'
import { en, zh } from './locales.ts'
import { createFilesStore } from './store.ts'

export type { SidebarFilesKey } from './locales.ts'
export type { DirLevel, FilesState, FilesTabState, LevelState } from './store.ts'
export type { FilesInjected, ListWorkspaceDirectory, WorkspaceFilesListRemote } from './face.ts'
export type { FilesBodyProps } from './FilesBody.tsx'

/** This package's copy namespace. */
const NS = 'sidebarFiles'

/**
 * Required browser services: the tab registry, the keyed seat, the Remote
 * carrier and its namespace, and copy.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles']

/**
 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
 * @param ctx - client root context carrying the registry, the slots, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'workspace.files' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['workspace files', 'files'],
      defaults: {
        'desktop:macos': { code: 'KeyP', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyP', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyP', modifiers: ['primary'] },
        'web:macos': { code: 'KeyP', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyP', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('files', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-files: shortcut')
  })
  ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), 'ui-sidebar-files: files type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-files: dictionaries')

  const store = createFilesStore()
  const inject = filesFace(createList(ctx.remote), createWatch(ctx.remote))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: FILES_ID, locale: NS, store, inject },
    FilesBody,
  )), 'ui-sidebar-files: files tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: FILES_ID },
    FilesTitle,
  )), 'ui-sidebar-files: files tab title')
}
