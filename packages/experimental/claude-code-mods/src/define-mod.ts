/**
 * `defineMod`: wrap a Claude Code mod's `register(on, options)` as a DSH
 * plugin. Mounting the plugin registers the mod with the bridge service
 * (`ctx.claudeCodeMods`); unmounting it removes the mod's hooks, timers, and
 * registrations. Mods load in composition order, which is their chain order.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModDefinition, ModRegister, PluginOptions } from './types.ts'

/** The option values a composition may set for a mod: `userConfig`'s value types. */
export type ModConfig = Record<string, string | number | boolean | string[]>

/** What a mod's plugin declares: the plugin identity and the hooks module's `register`. */
export interface ModSpec {
  /** Plugin name, as `.claude-plugin/plugin.json` names it: letters, digits, `_` and `-`. */
  readonly name: string
  readonly version?: string
  /** Absolute directory the mod ships in, reported by `$.plugin.root`. */
  readonly root?: string
  /** `userConfig` defaults: the `options` `register` receives when the composition sets none. */
  readonly userConfig?: PluginOptions
  readonly register: ModRegister
}

/** A mod wrapped as a DSH plugin; its config is the mod's `options`. */
export interface ModPlugin {
  readonly name: string
  readonly inject: readonly string[]
  readonly Config: z<ModConfig>
  /** The mod as the bridge and the test kit load it, with `userConfig` as its options. */
  readonly definition: ModDefinition
  apply(ctx: Context, config: ModConfig): Promise<() => Promise<void>>
}

const optionValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])

/**
 * Wrap one mod as a DSH plugin.
 * @param spec - the mod's identity, `userConfig` defaults, and `register`.
 * @returns a plugin object for `cordis.yml` or `ctx.plugin`; its `config` overlays `userConfig` as `register`'s `options`.
 */
export function defineMod(spec: ModSpec): ModPlugin {
  const userConfig: PluginOptions = Object.freeze({ ...spec.userConfig })
  const definition: ModDefinition = Object.freeze({
    name: spec.name,
    ...spec.version === undefined ? {} : { version: spec.version },
    ...spec.root === undefined ? {} : { root: spec.root },
    options: userConfig,
    register: spec.register,
  })
  return {
    name: `claude-code-mod-${spec.name}`,
    inject: ['claudeCodeMods'],
    Config: z.dict(optionValue).default({}),
    definition,
    // A `register` that throws fails this plugin's mount, as any misconfigured plugin does; the rest of the composition continues.
    // The disposer is the return value, which Cordis collects even when the plugin was removed while `register` ran.
    apply(ctx: Context, config: ModConfig): Promise<() => Promise<void>> {
      return ctx.claudeCodeMods.add({ ...definition, options: Object.freeze({ ...userConfig, ...config }) })
    },
  }
}
