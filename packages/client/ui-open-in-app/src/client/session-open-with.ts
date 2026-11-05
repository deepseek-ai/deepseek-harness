/** Application submenus for captured Sessions, shared by header and row menus. */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextMenuTargetMap, MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { OPEN_IN_APP_ICON_PREFIX_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { APP_LABEL_KEY } from './applications.ts'
import type { OpenInAppController } from './controller.ts'
import type { OpenInAppToastSource } from './open-toast.tsx'

/**
 * Share directory availability, successful choices, and launch feedback with the file-tree control.
 * @param ctx - owning plugin context.
 * @param controller - directory application catalog and launcher.
 * @param t - localized action labels.
 * @param report - app-wide native operation feedback; launch failures resolve without registry feedback.
 */
export function registerSessionOpenWith(
  ctx: Context,
  controller: OpenInAppController,
  t: PropsLocale<'open-in-app'>['t'],
  report: OpenInAppToastSource['report'],
): void {
  const resolve = ({ sessionId }: ContextMenuTargetMap['sessionHeader']): readonly MenuAction[] => {
    const directory = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    const applications = (controller.apps.getSnapshot() ?? []).flatMap((id) => {
      const key = APP_LABEL_KEY[id]
      return key === undefined ? [] : [{ id, name: t(key) }]
    })
    if (!directory || applications.length === 0) return []
    const disabled = controller.operation.getSnapshot().phase === 'busy'
    return [{
      id: 'openWith', label: t('menu.openIn'), icon: { key: 'open-in-app.application' }, disabled,
      children: applications.map(({ id, name }) => ({
        id: `app:${id}`, label: name, disabled,
        icon: { key: 'open-in-app.application', src: `${OPEN_IN_APP_ICON_PREFIX_ROUTE}/${id}` },
        run: async () => {
          const outcome = await controller.launch(id, directory)
          if (outcome.kind === 'opened') controller.choose(id)
          report(outcome)
        },
      })),
    }]
  }
  for (const target of ['session', 'sessionHeader'] as const) {
    ctx.effect(() => ctx.contextMenus.register({
      id: 'open-in-app.openWith', target, order: 500,
      observe: () => [controller.apps, controller.operation, ctx.sessions.list, ctx.locale],
      resolve: value => resolve(value).map(action => target === 'sessionHeader' ? { ...action, separatorBefore: true } : action),
    }), `open-in-app: ${target} directory menu`)
  }
}
