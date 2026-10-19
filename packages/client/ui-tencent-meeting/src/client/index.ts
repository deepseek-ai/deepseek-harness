/**
 * Tencent Meeting plugin, browser half: the account section on the Tencent Meeting bundle's page, the tag beside its
 * title, guidance after the bundle is switched on, and notices. The Host's `tencentMeeting` Remote owns the account
 * operations; this half mounts that Remote itself because the on-demand package stays out of the shipped Remote assembly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import tencentMeetingRemote from '@deepseek-ai/dsh-tencent-meeting-cli/remote'
import { TENCENT_MEETING_PACKAGE, createConnection } from './connection.ts'
import { en, NS, zh } from './locales.ts'
import {
  TencentMeetingConnectionActivation,
  TencentMeetingConnectionBadge,
  TencentMeetingConnectionSection,
  TencentMeetingConnectionToast,
} from './TencentMeetingConnection.tsx'

/** Services the Remote mount and the slot registrations need. */
export const inject = ['remote', 'slots', 'locale']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tencent-meeting: dictionaries')
  const { connection, face } = createConnection(ctx)
  ctx.effect(() => async () => { await connection.dispose() }, 'tencent-meeting: connection')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: TENCENT_MEETING_PACKAGE, locale: NS, inject: () => face,
  }, TencentMeetingConnectionSection))
  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
    name: 'plugins.bundle.activation', key: TENCENT_MEETING_PACKAGE, locale: NS, inject: () => face,
  }, TencentMeetingConnectionActivation))
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge', id: 'tencent-meeting.connection', locale: NS, inject: () => face,
  }, TencentMeetingConnectionBadge))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'tencent-meeting.connection-toast', locale: NS, inject: () => face,
  }, TencentMeetingConnectionToast))
}

/**
 * Mount the Tencent Meeting Remote, then register the account surfaces for as long as the Tencent Meeting row is on.
 * @param ctx - the browser plugin context.
 * @returns a disposer that withdraws the surfaces, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(tencentMeetingRemote)
  const ui = ctx.inject(['remote.tencentMeeting', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
