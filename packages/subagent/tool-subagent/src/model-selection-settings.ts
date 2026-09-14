/** Host-owned opt-in setting for model-selectable subagent delegation. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  type AllowedModelRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled when a new Session receives delegation tools. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** User-settings section for model-selectable subagent delegation. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = 'subagent-model-selection'

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Whether newly composed top-level Sessions receive model selection. */
  enabled: boolean
  /** Exact child LLM routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedModelRoute[]
}

/** Schema served to settings clients for the opt-in preference. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA: z<SubagentModelSelectionSettings> = z.object({
  enabled: z.boolean().default(false),
  allowedModels: z.array(AllowedModelRouteSchema).default([]),
})

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial enabled state inherited when the user document does not override it. */
  enabled?: boolean
  /** Initial route list inherited when the user document does not override it. */
  allowedModels?: AllowedModelRoute[]
}

/** Singleton settings owner read when delegation tools are composed for a Session. */
export class SubagentModelSelectionConfig extends Service {
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false),
    allowedModels: z.array(AllowedModelRouteSchema).default([]),
  })

  private source: () => SubagentModelSelectionSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'subagentModelSelection')
    // Cordis supplies the schema default; the fallback also covers direct construction.
    /* v8 ignore next */
    const entry: SubagentModelSelectionSettings = {
      enabled: config.enabled ?? false,
      allowedModels: config.allowedModels ?? [],
    }
    this.validate(entry)
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(
        ctx,
        SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
        SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA,
        entry,
        {
          setSource: (source) => { this.source = source },
          validate: (value) => { this.validate(value) },
          // Consumers snapshot per Session, so a settings update never rebuilds
          // the tool definitions of a Session that is already running.
          onChange: () => {},
        },
      )
    })
  }

  /**
   * Read a detached selection preference for the next eligible Session composition.
   * @returns the enabled state and exact allowed routes.
   */
  current(): SubagentModelSelectionSettings {
    const current = this.source()
    return {
      enabled: current.enabled,
      allowedModels: current.allowedModels.map(route => ({ ...route })),
    }
  }

  private validate(value: SubagentModelSelectionSettings): void {
    assertAllowedModelRoutes(value.allowedModels)
    if (value.enabled && value.allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
  }
}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
