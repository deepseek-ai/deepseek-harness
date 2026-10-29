/** Native path and URL menu contributions, independent of their trigger components. */
import { IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OpenInAppController } from './controller.ts'
import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { OpenInAppPathController } from './open-path.ts'
import type { OpenInAppKey } from './locales.ts'
import type { OpenInAppToastSource } from './open-toast.tsx'

/**
 * Register native opening, original-path reveal, and URL actions.
 * @param ctx - declared plugin dependencies.
 * @param paths - existing native file actions.
 * @param t - localized action labels.
 * @param directories - installed directory applications.
 * @param report - native operation feedback shared with the application controls.
 */
export function registerContextMenus(
  ctx: Context,
  paths: OpenInAppPathController,
  t: (key: OpenInAppKey, values?: Record<string, string>) => string,
  directories: OpenInAppController,
  report: OpenInAppToastSource['report'],
): void {
  const fileManager = () => t(directories.apps.getSnapshot()?.includes('finder') ? 'menu.finder' : 'menu.reveal')
  const open = async (path: string, action: 'open' | 'reveal', application?: string): Promise<void> => {
    report(await paths.openPath(path, action, application))
  }
  const resolvePath = async (sessionId: SessionId, path: string, signal: AbortSignal): Promise<string | undefined> => {
    try {
      const result = await ctx.remote.workspaceFiles.stat(sessionId, path, signal)
      return result.ok ? result.value.absolutePath : undefined
    }
    catch (_error) {
      // An unavailable metadata carrier disables path actions; URL and clipboard actions remain independent.
      signal.throwIfAborted()
      return undefined
    }
  }
  ctx.effect(() => ctx.contextMenus.register({
    id: 'open-in-app.workspace', target: 'workspace', order: 200,
    resolve: async ({ path }, signal) => {
      await directories.load()
      signal.throwIfAborted()
      const manager = directories.apps.getSnapshot()?.find(id => ['finder', 'explorer', 'filemanager'].includes(id))
      return [{ id: 'reveal', icon: { key: 'open-in-app.reveal' }, label: fileManager(), disabled: manager === undefined,
        failureLabel: t('path.revealError'),
        ...manager === undefined ? {} : { run: async () => {
          const outcome = await directories.launch(manager, path)
          report(outcome.kind === 'failed' ? { kind: 'failed', failure: 'revealError' } : outcome)
        } } }]
    },
  }), 'open-in-app: Workspace context menu')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'open-in-app.directory', target: 'directory', order: 100,
    resolve: async ({ sessionId, path }, signal) => {
      await paths.load()
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      const absolutePath = resolveWorkspacePath(cwd, path)
      signal.throwIfAborted()
      return [
        { id: 'reveal', icon: { key: 'open-in-app.reveal' }, label: fileManager(), disabled: paths.desktop.getSnapshot() !== true,
          run: () => open(absolutePath, 'reveal') },
        { id: 'copyPath', icon: { key: 'open-in-app.copy' }, label: t('menu.copyDirectoryPath'), failureLabel: t('menu.copyFailed'), run: async () => {
          await navigator.clipboard.writeText(absolutePath)
          ctx.contextMenus.notify(t('menu.copied'), true)
        } },
      ]
    },
  }), 'open-in-app: directory context menu')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'open-in-app.file', target: 'file', order: 100,
    resolve: async (target, signal) => {
      const { sessionId, path, line } = target
      await paths.load()
      const absolutePath = await resolvePath(sessionId, path, signal)
      const available = absolutePath !== undefined
      const desktop = paths.desktop.getSnapshot() === true && available
      const apps = desktop ? await paths.applications(absolutePath, signal) : []
      signal.throwIfAborted()
      const application = apps?.find(app => app.default)
      // The menu names a host, not the pane it was raised in: a floating pane is never a docked landing place.
      const openIn = (destination: 'sidebar' | 'float') => () => {
        const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
        ctx.sidebarRight.openResourceIn(sessionId, fileAddressFor(sessionId, cwd, path), {
          destination, ...(line === undefined ? {} : { params: { line } }),
        })
      }
      return [
        { id: 'sidebar', icon: { key: 'open-in-app.sidebar' }, label: t('menu.openInSidebar'), disabled: !available, run: openIn('sidebar') },
        { id: 'float', icon: { key: 'open-in-app.float' }, label: t('menu.openInFloat'), disabled: !available, run: openIn('float') },
        { id: 'reveal', icon: { key: 'open-in-app.reveal' }, label: fileManager(), disabled: !desktop,
          ...absolutePath === undefined ? {} : { run: () => open(absolutePath, 'reveal') } },
        { id: 'open', label: application ? t('open.title', { app: application.name }) : t('menu.defaultApp'),
          icon: { key: 'open-in-app.application', ...application?.icon ? { src: application.icon } : {} },
          disabled: application === undefined,
          ...absolutePath === undefined || application === undefined ? {} : { run: () => open(absolutePath, 'open', application.id) } },
        { id: 'copyPath', icon: { key: 'open-in-app.copy' }, failureLabel: t('menu.copyFailed'), label: t('menu.copyPath'),
          run: async () => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            await navigator.clipboard.writeText(absolutePath ?? resolveWorkspacePath(cwd, path))
            ctx.contextMenus.notify(t('menu.copied'), true)
          } },
      ]
    },
  }), 'open-in-app: file context menu')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'open-in-app.url', target: 'url', order: 100,
    resolve: ({ sessionId, url }) => [
      { id: 'sidebar', icon: { key: 'open-in-app.sidebar' }, label: t('menu.openInSidebar'), disabled: ctx.sidebarRightTabs.get('browser') === undefined,
        run: () => { ctx.sidebarRight.openTabIn(sessionId, 'browser', { params: { url } }) } },
      { id: 'external', label: t('menu.external'),
        run: () => { window.open(url, '_blank', 'noopener,noreferrer') } },
      { id: 'copy', icon: { key: 'open-in-app.copy' }, failureLabel: t('menu.copyFailed'), label: t('menu.copyLink'), run: async () => {
        await navigator.clipboard.writeText(url); ctx.contextMenus.notify(t('menu.copied'), true)
      } },
    ],
  }), 'open-in-app: URL context menu')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'open-in-app.image', target: 'image', order: 200,
    resolve: async (target, signal) => {
      const { sessionId, path } = target
      await paths.load()
      const local = path !== undefined && sessionId !== undefined && paths.desktop.getSnapshot() === true
        ? await resolvePath(sessionId, path, signal) : undefined
      signal.throwIfAborted()
      return [
        { id: 'reveal', icon: { key: 'open-in-app.reveal' }, label: fileManager(), disabled: local === undefined,
          ...local !== undefined ? { run: () => open(local, 'reveal') } : {} },
      ]
    },
  }), 'open-in-app: image context menu')
}

/** @param props - icon metadata captured with the resolved action. @returns Application image or the native-open glyph. */
export function ContextMenuApplicationIcon({ icon }: Pick<PropsRuntime<'contextMenu.icon'>, 'icon'>) {
  return icon.src ? <img src={icon.src} width={14} height={14} alt="" /> : <IconRightUpOutlineRegular />
}
