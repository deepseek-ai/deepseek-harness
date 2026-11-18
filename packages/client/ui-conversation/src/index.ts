/** Browser conversation preferences. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConversationConfig } from './types.ts'
import { BUSY_ENTER_FIELD } from './submission-settings.ts'

import { ConversationSettingsFields } from './submission-settings.ts'

export {
  BUSY_ENTER_BEHAVIORS, BUSY_ENTER_FIELD, CONVERSATION_SETTINGS_NAMESPACE,
  DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior, type ConversationSettings,
} from './submission-settings.ts'

/** Live preferences; the browser receives every field through its synced Config. */
export type Config = ConversationConfig

/** Live preferences projected to the browser. */
export const Config = z.object({
  [BUSY_ENTER_FIELD]: ConversationSettingsFields[BUSY_ENTER_FIELD].volatile(),
  maxConcurrentFileUploads: z.natural().min(1).default(2).volatile(),
})

/** Register browser conversation preferences.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
