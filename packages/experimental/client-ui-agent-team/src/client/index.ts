/** Browser entry registering the Agent Teams conversation-header action. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { registerAgentTeamUi } from './mount.ts'

export { inject } from './mount.ts'
export type { TeamActionInjected, TeamActionProps } from './TeamAction.tsx'
export type { TeamKey } from './locales.ts'

/**
 * Register the Team locale dictionaries and header action on the Client Context.
 * @param ctx - Client Context with the declared `inject` services available.
 */
export function apply(ctx: ClientContext): void {
  registerAgentTeamUi(ctx)
}
