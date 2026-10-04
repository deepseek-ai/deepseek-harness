/**
 * The `claude-code` module as a mod's `types/index.d.ts` augments it: the
 * `PluginState` interface a mod declares its `$.state` keys in. This host
 * reads no declarations; the module exists so the example mods' type
 * contracts compile unchanged.
 * @module
 */

/** State keys by plugin, as `declare module 'claude-code' { interface PluginState { … } }` adds them. */
export interface PluginState {}

export type { ModOn as On, ModRegister as Register, ModsApi as Api } from '../../src/types.ts'
