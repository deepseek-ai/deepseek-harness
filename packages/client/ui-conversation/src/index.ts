/** Host continuation eligibility and browser conversation preferences. */
import type {} from '@deepseek-ai/dsh-settings'
export type {} from './continuation-types.ts'

import type { Volatile, Context } from '@deepseek-ai/cordis'
import type { BusyEnterBehavior } from './submission-settings.ts'
import z from '@deepseek-ai/schemastery'
import { BUSY_ENTER_FIELD } from './submission-settings.ts'

import { ConversationSettingsFields } from './submission-settings.ts'
import { continuationProjectionDefinition } from './host/continuation.ts'

export {
  BUSY_ENTER_BEHAVIORS, BUSY_ENTER_FIELD, CONVERSATION_SETTINGS_NAMESPACE,
  DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior, type ConversationSettings,
} from './submission-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Enter key behavior while a turn is running. */
  busyEnter: Volatile<BusyEnterBehavior>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  [BUSY_ENTER_FIELD]: ConversationSettingsFields[BUSY_ENTER_FIELD].volatile(),
})

/** Required registry for the durable generation-continuation projection. */
export const inject = ['sessionProjections']

/** Register generation-continuation eligibility and browser preferences.
 * @param ctx Plugin context used for optional settings presentation.
 * @returns when continuation state is registered and available to Session carriers.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  await ctx.sessionProjections.register(continuationProjectionDefinition)
}
