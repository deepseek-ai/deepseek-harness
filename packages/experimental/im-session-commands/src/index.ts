/**
 * `/stop`, `/clear`, `/new`, `/status`, `/help` and dsh command passthrough (`/compact` …) for IM chats.
 *
 * The plugin sits at the head of the `im/message` waterfall (`prepend: true`) and acts only on a parsed
 * `message.command` of an addressed message — the intake parses commands in groups regardless of addressing, so
 * the addressed gate lives here. Anything it does not understand returns `next()`, letting routing strategies treat
 * the text as model input. Every reply goes through `event.reply`; the first reply and outcome of each handled
 * message are persisted in `im_session_commands`, so a redelivery replays the recorded answer without recomputing.
 *
 * @module @deepseek-ai/dsh-im-session-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { ImMessageEvent, ImOutcome } from '@deepseek-ai/dsh-im'
import { SessionCommands } from './commands.ts'
import type { SessionCommandsConfig } from './config.ts'

export { Config, type SessionCommandAllow, type SessionCommandsConfig } from './config.ts'
export type { ImSessionCommandsDomain, StoredCommandReceipt } from './commands.ts'
export type { SessionCommandStrings, SessionCommandsLocale } from './locale.ts'

export const name = 'session-commands'
/** The IM host, the dsh command registry, the agent registry, and durable receipt storage. */
export const inject = ['im', 'commands', 'agents', 'storageDomain']

/**
 * Mount the session-command listener and open its durable receipt store.
 * @param ctx - context carrying `im`, `commands`, `agents` and `storageDomain`.
 * @param config - resolved operator configuration.
 * @returns resolution once the durable command receipt store is open and the listener is active.
 */
export async function apply(ctx: Context, config: SessionCommandsConfig): Promise<void> {
  const commands = new SessionCommands(ctx, config)
  ctx.effect(() => () => commands.dispose())
  ctx.on('im/message', (event: ImMessageEvent, next: () => Promise<ImOutcome>) => commands.handle(event, next),
    { prepend: true })
  await commands.start()
}
