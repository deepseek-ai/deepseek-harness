/** Native directory reveal contributed to the captured Session's structured menu. */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OpenInAppController } from './controller.ts'
import type { OpenInAppToastSource } from './open-toast.tsx'

/**
 * Share directory availability and launch feedback with the existing application controls.
 * @param ctx - owning plugin context.
 * @param controller - directory application catalog and launcher.
 * @param t - localized action and failure labels.
 * @param report - native operation feedback shared with the application controls.
 */
export function registerSessionReveal(
  ctx: Context,
  controller: OpenInAppController,
  t: PropsLocale<'open-in-app'>['t'],
  report: OpenInAppToastSource['report'],
): void {
  ctx.effect(() => ctx.contextMenus.register({
    id: 'open-in-app.reveal', target: 'session', order: 500,
    observe: () => [controller.apps, ctx.sessions.list, ctx.locale],
    resolve: ({ sessionId }) => {
      const directory = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      const applications = controller.apps.getSnapshot()
      const manager = applications?.find(id => ['finder', 'explorer', 'filemanager'].includes(id))
      return [{
        id: 'reveal', label: t(applications?.includes('finder') ? 'menu.finder' : 'menu.reveal'), icon: { key: 'open-in-app.reveal' },
        disabled: !directory || manager === undefined, failureLabel: t('path.revealError'),
        ...(directory && manager !== undefined ? { run: async () => {
          const outcome = await controller.launch(manager, directory)
          report(outcome.kind === 'failed' ? { kind: 'failed', failure: 'revealError' } : outcome)
        } } : {}),
      }]
    },
  }), 'open-in-app: Session directory menu')
}
