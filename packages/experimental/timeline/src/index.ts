import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { TimelineError } from './error.ts'
import { Config, liveConfig } from './config.ts'
import type { PluginConfig } from './config.ts'
import { registerProjection } from './projection.ts'
import { installTools } from './tools.ts'
import { installReports } from './reports.ts'
import { installGuidance } from './guidance.ts'
import { installReminders } from './reminders.ts'
import { TimelineStorage } from './storage.ts'
import type { OutputLanguage } from './policy.ts'
import { installCommand } from './command.ts'
import { installDelegation, planningOwner } from './delegation.ts'

export { Config }
export const name = 'timeline'
export const inject = [
  'agents',
  'sessions',
  'sessionProjections',
  'tools',
  'llm',
  'systemPrompt',
]

/**
 * Install Timeline for the profile's agents and client.
 * @param ctx Plugin context.
 * @param input Loader-owned Timeline settings.
 */
export async function apply(ctx: Context, input: PluginConfig): Promise<void> {
  const standalone = [...(ctx.get('loader')?.entries() ?? [])].some(
    entry => !entry.disabled && entry.options.name.replace(/^cordis:/u, '') === '@magolor/dsh-timeline',
  )
  if (standalone) throw new TimelineError('Disable the standalone Timeline plugin before enabling experimental Timeline.', 'TIMELINE_PLUGIN_CONFLICT')
  let browserLanguage: OutputLanguage | undefined
  const config = liveConfig(input, () => {
    const locale = ctx.get('settings')?.describe({ redactSecrets: true }).find(item => item.ns === 'locale')
    const value: unknown = locale?.value
    return typeof value === 'object' && value !== null && 'preference' in value &&
      typeof value.preference === 'string'
      ? value.preference
      : browserLanguage ?? Intl.DateTimeFormat().resolvedOptions().locale
  })
  const projection = await registerProjection(ctx)
  const storage = new TimelineStorage(ctx, projection, config, (language) => { browserLanguage = language })
  installTools(ctx, config, storage)
  const owns = planningOwner(ctx)
  installDelegation(ctx, owns)
  installCommand(ctx, storage)
  installGuidance(ctx, config, storage, owns)
  installReminders(ctx, config, storage, owns)
  installReports(ctx, config, storage, owns)
}
