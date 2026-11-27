/** Host-owned opt-in setting for model-selectable subagent delegation. */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
// Retains the released Session event declaration in emitted declarations.
import './model-selection-state.ts'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  type AllowedModelRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference read for explicit child route selection and route discovery. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** Optional deployment base for the preference; the shipped composition defaults it off. */
export interface Config {
  /** Whether Agents may select a child route from `allowedModels`; inherited when the user document does not override it. */
  enabled: Volatile<boolean>
  /** Initial route list inherited when the user document does not override it. */
  allowedModels: Volatile<AllowedModelRoute[]>
  /** Route that replaces parent inheritance for children started without route fields; omission inherits the parent route. */
  defaultModel: Volatile<AllowedModelRoute | undefined>
}

/** Host settings owner whose current value authorizes explicit child routes and names the default child route in every Session. */
export class SubagentModelSelectionConfig extends Service {
  static Config = z.object({
    enabled: z.boolean().default(false).volatile(),
    allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile(),
    // Prevent Schemastery from materializing an omitted route as `{}`.
    defaultModel: (AllowedModelRouteSchema as z<AllowedModelRoute | undefined>).default(undefined).volatile(),
  })

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentModelSelection')
  }

  /**
   * Read the routes the setting currently authorizes. Each call samples the
   * live setting, so an edit applies to the next delegation in every Session.
   * @returns a detached route list, or undefined when the setting is disabled.
   * @throws {SubagentError} `INVALID_MODEL_SELECTION_SETTINGS` when the enabled setting has no route,
   *   or its routes are malformed or repeated. Disabled settings do not read or validate routes.
   */
  allowedRoutes(): AllowedModelRoute[] | undefined {
    if (!this.config.enabled.get()) return undefined
    const allowedModels = this.config.allowedModels.get()
    assertAllowedModelRoutes(allowedModels)
    if (allowedModels.length === 0) {
      throw new SubagentError('enabled subagent model selection requires at least one allowed model', 'INVALID_MODEL_SELECTION_SETTINGS')
    }
    return allowedModels.map(route => ({ ...route }))
  }

  /**
   * Read the route a child uses when its delegation names none. Each call
   * samples the live setting, independently of `enabled` and `allowedModels`.
   * @returns a detached route, or undefined when the setting names none.
   */
  defaultRoute(): AllowedModelRoute | undefined {
    const route = this.config.defaultModel.get()
    return route === undefined ? undefined : { provider: route.provider, model: route.model }
  }
}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
