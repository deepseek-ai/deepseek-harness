/**
 * `/stop`, `/clear`, `/new`, `/status`, `/help` and dsh command passthrough (`/compact` …) for IM chats.
 *
 * The plugin sits at the head of the `im/message` waterfall (`prepend: true`) and acts only on a parsed
 * `message.command` of an addressed message — the intake parses commands in groups regardless of addressing, so
 * the addressed gate lives here. Anything it does not understand returns `next()`, letting routing strategies treat
 * the text as model input. Every reply goes through `event.reply`; the returned outcome (`handled by
 * session-commands`) is recorded by the core, so a redelivery does not act twice.
 *
 * @module @deepseek-ai/dsh-im-session-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImMessageEvent, ImOutcome } from '@deepseek-ai/dsh-im'
import { SessionCommands } from './commands.ts'
import type { SessionCommandsConfig } from './config.ts'

export { Config, type SessionCommandAllow, type SessionCommandsConfig } from './config.ts'
export type { SessionCommandStrings, SessionCommandsLocale } from './locale.ts'

export const name = 'session-commands'
/** The IM host, the dsh command registry and the agent registry the commands act on. */
export const inject = ['im', 'commands', 'agents']

/**
 * Mount the session-command listener.
 * @param ctx - context carrying `im`, `commands` and `agents`.
 * @param config - resolved operator configuration.
 */
export function apply(ctx: Context, config: SessionCommandsConfig): void {
  const commands = new SessionCommands(ctx, config)
  ctx.effect(() => () => { commands.dispose() })
  ctx.on('im/message', (event: ImMessageEvent, next: () => Promise<ImOutcome>) => commands.handle(event, next),
    { prepend: true })
}
