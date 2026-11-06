/** Native path and URL menu contributions, independent of their trigger components. */
import { useState } from 'react'
import { IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { ContextMenuTargetMap, MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'
import type { OpenInAppController } from './controller.ts'
import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { OpenInAppPathController } from './open-path.ts'
import type { OpenInAppKey } from './locales.ts'
import type { OpenInAppToastSource } from './open-toast.tsx'

type Applications = readonly SessionWorkspacePathApplication[]
/** A file menu's verified Host path and the association answer its resolution showed. */
interface Verification { readonly absolutePath: string; readonly shown: Applications | undefined }

/**
 * How long a file menu waits for the first association answer of its file type before opening with the
 * unnamed default-application row; most first answers arrive sooner, so the row rarely changes after opening.
 */
const FIRST_ANSWER_WAIT_MS = 300

/**
 * @param pending - settles without rejecting.
 * @param ms - longest wait.
 * @param signal - ends the wait early.
 * @returns settles when `pending` settles, after `ms`, or on abort, whichever comes first; the timer never outlives it.
 */
function settleWithin(pending: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((settle) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); settle() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    void pending.then(done)
  })
}

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
  const fileMenu = (target: ContextMenuTargetMap['file'], absolutePath: string | undefined): MenuAction[] => {
    const { sessionId, path, line } = target
    const available = absolutePath !== undefined
    const desktop = paths.desktop.getSnapshot() === true && available
    // Undefined until the Host first answers for this file type; the row then opens through the association.
    const apps = desktop ? paths.cachedApplications(absolutePath) : []
    const application = apps?.find(app => app.default)
    const openApplication = absolutePath === undefined || !desktop ? undefined
      : application !== undefined ? () => open(absolutePath, 'open', application.id)
        : apps === undefined ? () => open(absolutePath, 'open') : undefined
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
        disabled: openApplication === undefined, ...openApplication === undefined ? {} : { run: openApplication } },
      { id: 'copyPath', icon: { key: 'open-in-app.copy' }, failureLabel: t('menu.copyFailed'), label: t('menu.copyPath'),
        run: async () => {
          const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
          await navigator.clipboard.writeText(absolutePath ?? resolveWorkspacePath(cwd, path))
          ctx.contextMenus.notify(t('menu.copied'), true)
        } },
    ]
  }
  // The Host path from each file target's latest successful stat and the answer its menu showed, shared by menus open
  // on one target object at once. A stat clears it while running; answers arriving meanwhile need no re-resolution, as
  // that stat's resolution reads the newest answers.
  const verified = new WeakMap<ContextMenuTargetMap['file'], Verification>()
  // The target whose changed association answer is being applied; only that re-resolution reuses the verified path,
  // so every opening runs its own stat. The in-place update relies on the registry re-resolving synchronously from
  // the notification, without which the menu stats again, and on a synchronous resolution replacing rows without
  // clearing them first, without which the rows flicker.
  let answering: ContextMenuTargetMap['file'] | undefined
  ctx.effect(() => ctx.contextMenus.register({
    id: 'open-in-app.file', target: 'file', order: 100,
    observe: target => [{
      getSnapshot: paths.associations.getSnapshot.bind(paths.associations),
      subscribe: (listener: () => void) => {
        // The answer this subscription last applied for a verification; answers for other file types leave it unchanged.
        let applied: { readonly verification: Verification; readonly applications: Applications | undefined } | undefined
        return paths.associations.subscribe(() => {
          const verification = verified.get(target)
          if (verification === undefined) return
          const applications = paths.cachedApplications(verification.absolutePath)
          const current = applied?.verification === verification ? applied.applications : verification.shown
          if (applications === current) return
          applied = { verification, applications }
          answering = target
          try { listener() } finally { answering = undefined }
        })
      },
    }],
    resolve: (target, signal) => {
      const reused = answering === target ? verified.get(target) : undefined
      if (reused !== undefined) return fileMenu(target, reused.absolutePath)
      verified.delete(target)
      return (async () => {
        await paths.load()
        const absolutePath = await resolvePath(target.sessionId, target.path, signal)
        signal.throwIfAborted()
        if (absolutePath === undefined) return fileMenu(target, undefined)
        if (paths.desktop.getSnapshot() === true) {
          // Every opening re-queries so a changed association reaches this menu; a type's first opening waits for it briefly.
          const unanswered = paths.cachedApplications(absolutePath) === undefined
          const refreshed = paths.refreshApplications(absolutePath)
          if (unanswered) {
            await settleWithin(refreshed, FIRST_ANSWER_WAIT_MS, signal)
            signal.throwIfAborted()
          }
        }
        verified.set(target, { absolutePath, shown: paths.cachedApplications(absolutePath) })
        return fileMenu(target, absolutePath)
      })()
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
  const [failedSource, setFailedSource] = useState<string>()
  return icon.src && icon.src !== failedSource
    ? <img src={icon.src} width={14} height={14} alt="" draggable={false} onError={() => { setFailedSource(icon.src) }} />
    : <IconRightUpOutlineRegular />
}
