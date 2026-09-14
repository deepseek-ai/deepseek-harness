/**
 * Immutable launch-time environment snapshot that records which layer
 * supplied each value. Harness consumers resolve through it instead of a flattened
 * `process.env`; launchers may still materialize accepted values for config
 * expressions and third-party libraries.
 * @module @deepseek-ai/dsh-launch-environment
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Which layer supplied a value, from most to least trusted: the environment
 * this process inherited, the invoking directory's `.env`, the Harness home's
 * `.env`.
 */
export type LaunchEnvironmentSource = 'process' | 'project-env' | 'user-env'

/** Layer order, most trusted first. */
const SOURCE_ORDER: readonly LaunchEnvironmentSource[] = ['process', 'project-env', 'user-env']

/** One resolved variable and the layer it came from. */
export interface LaunchEnvironmentEntry {
  /** The value as the layer supplied it; may be empty, which each owner judges for itself. */
  value: string
  /** The layer that supplied it. */
  source: LaunchEnvironmentSource
  /** Absolute path of the file that supplied it; absent for `process`. */
  path?: string
}

/**
 * The frozen environment of one launch. Construct through
 * {@link createLaunchEnvironmentSnapshot}; nothing mutates it afterwards, so a
 * later `chdir`, workspace switch, or resumed session observes the same
 * values a consumer resolved at boot.
 */
export interface LaunchEnvironmentSnapshot {
  /**
   * Resolve one name across every layer, most trusted first.
   * @param name - the variable name.
   * @returns the winning entry, or `undefined` when no layer supplies it.
   */
  get(name: string): LaunchEnvironmentEntry | undefined
  /**
   * Resolve one name only from `sources`, retaining canonical trust order;
   * omitted layers are unreachable.
   * @param name - the variable name.
   * @param sources - the layers allowed in the canonical trust order.
   * @returns the first matching entry, or `undefined`.
   */
  getFrom(name: string, sources: readonly LaunchEnvironmentSource[]): LaunchEnvironmentEntry | undefined
}

/**
 * The map key one variable name resolves under. Windows treats environment
 * names case-insensitively; every other platform does not.
 * @param name - the variable name as written.
 * @returns the key to store and look up by.
 */
function lookupKey(name: string): string {
  /* v8 ignore next -- native Windows coverage exercises the folding arm; POSIX covers the exact one */
  return process.platform === 'win32' ? name.toUpperCase() : name
}

/** One layer's raw contents, as {@link createLaunchEnvironmentSnapshot} receives them. */
export interface LaunchEnvironmentLayerInput {
  source: LaunchEnvironmentSource
  /** Absolute path of the file behind this layer; omit for `process`. */
  path?: string
  values: Readonly<Record<string, string>>
}

/**
 * Build the snapshot from each layer's contents.
 * @param layers - the layers in any order; the result searches them by canonical trust order.
 * @returns the immutable snapshot.
 */
export function createLaunchEnvironmentSnapshot(layers: readonly LaunchEnvironmentLayerInput[]): LaunchEnvironmentSnapshot {
  // Copy every layer so later mutations cannot change the snapshot. Fold names
  // on Windows so case variants cannot split precedence; POSIX remains exact.
  const bySource = new Map<LaunchEnvironmentSource, { path?: string; values: Map<string, string> }>()
  for (const layer of layers) {
    bySource.set(layer.source, {
      ...layer.path === undefined ? {} : { path: layer.path },
      values: new Map(Object.entries(layer.values).map(([name, value]) => [lookupKey(name), value])),
    })
  }
  const getFrom = (name: string, sources: readonly LaunchEnvironmentSource[]): LaunchEnvironmentEntry | undefined => {
    const key = lookupKey(name)
    for (const source of SOURCE_ORDER) {
      if (!sources.includes(source)) continue
      const layer = bySource.get(source)
      const value = layer?.values.get(key)
      if (value === undefined) continue
      return { value, source, ...layer?.path === undefined ? {} : { path: layer.path } }
    }
    return undefined
  }
  return {
    get: name => getFrom(name, SOURCE_ORDER),
    getFrom,
  }
}

/** Context slot the launcher fills with this run's snapshot before any config entry mounts. */
export const DSH_LAUNCH_ENVIRONMENT_KEY = 'launchEnvironment'

/**
 * Return the launcher's snapshot, or the inherited environment as the sole
 * layer when the host provided none.
 * @param ctx - the consuming plugin's context.
 * @returns the snapshot to resolve user-facing values against.
 */
export function launchEnvironmentOf(ctx: Context): LaunchEnvironmentSnapshot {
  return ctx.get(DSH_LAUNCH_ENVIRONMENT_KEY)
    ?? createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env as Record<string, string> }])
}

/**
 * Detect SSH from non-empty SSH_CONNECTION or SSH_TTY inherited at launch.
 * Project and user `.env` values never establish an SSH session.
 * @param environment - the launcher's environment snapshot.
 * @returns whether the inherited process layer carries either SSH marker.
 */
export function launchedThroughSsh(environment: LaunchEnvironmentSnapshot): boolean {
  return ['SSH_CONNECTION', 'SSH_TTY'].some((name) => {
    const value = environment.getFrom(name, ['process'])?.value
    return value !== undefined && value !== ''
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned snapshot of this run's environment; absent in compositions the product CLI did not boot. */
    launchEnvironment?: LaunchEnvironmentSnapshot
  }
}
