/** macOS native CUA provider using the shared application and window API. */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installCua, type CuaConfig, type CuaStartupCapabilities } from '@deepseek-ai/dsh-cua'
import { CuaConfigFields } from '@deepseek-ai/dsh-cua/config'
import { createPermissionParameters } from './permission-guide.ts'
import { nativeHostArchitecture, prepareNativeExecutable, type SourceSigning } from './native-build.ts'
import { createSharedNativeChannel } from './shared-native.ts'
import { installHeldKeys } from './held-keys.ts'
import { AX_TRAVERSAL_MAX } from './ax-limits.ts'
import { GUIDANCE } from './guidance.ts'
export { GUIDANCE } from './guidance.ts'

const CAPABILITIES: CuaStartupCapabilities = {
  platform: 'macos', systemPointer: true,
  methods: [
    'activate', 'click', 'drag', 'findApps', 'getApp', 'getCapabilities', 'getState', 'invoke',
    'listActions', 'listApps', 'listWindows', 'mouseMove', 'paste', 'performAction', 'pressKey', 'screenshot', 'scroll',
    'selectText', 'sendKeyEvent', 'setValue', 'show', 'typeText',
  ],
  appLevelAccessibility: true,
  keyboard: ['app'],
  browser: false,
  coordinateSpace: 'screenshot-pixels',
}

/** Loader plugin identity. */
export const name = 'experimental-cua-macos'
/** Services required by the shared CUA executor and the native launcher. */
export const inject = ['computerUse', 'tools', 'systemPrompt', 'subprocess', 'agents']
/** Native preparation, source-build signing, operation bounds, and profile-local application grants. */
export interface Config extends CuaConfig {
  /** Interval in milliseconds between permission and position checks while the native guide is open. */
  permissionPollIntervalMs: number
  /**
   * Source-build signing: `ad-hoc` (default) binds grants to the code hash;
   * an object selects an existing certificate in an explicitly configured keychain.
   * Installed packages and `helperPath` keep their own signature.
   */
  sourceSigning: SourceSigning
}
/** Validate shared operation bounds and macOS source signing before preparing the helper. */
export const Config = Schema.object({
  ...CuaConfigFields,
  maxElements: CuaConfigFields.maxElements.max(AX_TRAVERSAL_MAX.maxElements).default(5000),
  maxDepth: CuaConfigFields.maxDepth.max(AX_TRAVERSAL_MAX.maxDepth).default(50),
  permissionPollIntervalMs: Schema.number().step(1).min(100).max(2 ** 31 - 1).default(1000),
  sourceSigning: Schema.union([
    Schema.const('ad-hoc'),
    Schema.object({
      identity: Schema.string().pattern(/^[^-\s]/).required(),
      keychain: Schema.string().pattern(/^\/.+/).required(),
    }),
  ]).default('ad-hoc'),
}) satisfies Schema<Record<string, unknown>, Config>


/**
 * Mount logged native operations with separate Agent connections to the shared helper.
 * @param ctx - Host context with computer-use, subprocess and tool services.
 * @param config - Validated native preparation and operation bounds.
 * @returns Completion after native preparation and tool registration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const backend = { createChannel: createSharedNativeChannel, sendKeyEvent: installHeldKeys(ctx),
    guidance: GUIDANCE, capabilities: CAPABILITIES,
    permissionParameters: createPermissionParameters(config.permissionPollIntervalMs) }
  if (config.helperPath !== undefined) {
    if (!isAbsolute(config.helperPath)) throw new Error('dsh-cua helperPath must be absolute')
    installCua(ctx, config, { helperPath: config.helperPath, ...backend })
    return
  }
  const architecture = nativeHostArchitecture(process.platform, process.arch)
  const controller = new AbortController()
  const prepared = prepareNativeExecutable({
    packageRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
    architecture, sourceSigning: config.sourceSigning, subprocess: ctx.subprocess,
    timeoutMs: config.buildTimeoutMs, graceMs: config.graceMs, signal: controller.signal,
  })
  ctx.effect(() => async () => {
    controller.abort()
    // The Loader receives preparation failures through apply; disposal only awaits quiescence.
    await prepared.catch(() => {})
  }, 'dsh-cua.native-preparation')
  const helperPath = await prepared
  controller.signal.throwIfAborted()
  installCua(ctx, config, { helperPath, ...backend })
}
