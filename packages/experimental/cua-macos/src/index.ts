/** macOS native CUA provider using the shared application and window API. */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { CuaConfig, installCua } from '@deepseek-ai/dsh-cua'
import { nativeHostArchitecture, prepareNativeExecutable } from './native-build.ts'
import { createSharedNativeChannel } from './shared-native.ts'
import { GUIDANCE } from './guidance.ts'
export { GUIDANCE } from './guidance.ts'

/** Loader plugin identity. */
export const name = 'experimental-cua-macos'
/** Services required by the shared CUA executor and the native launcher. */
export const inject = ['computerUse', 'tools', 'systemPrompt', 'subprocess', 'agents']
/** Native preparation, operation bounds, and profile-local application grants. */
export type Config = CuaConfig
/** Validate the shared configuration before preparing the macOS helper. */
export const Config: typeof CuaConfig = CuaConfig

const description = 'Inspect macOS permissions, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state.'

/**
 * Mount logged native operations with separate Agent connections to the shared helper.
 * @param ctx - Host context with computer-use, subprocess and tool services.
 * @param config - Validated native preparation and operation bounds.
 * @returns Completion after native preparation and tool registration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.helperPath !== undefined) {
    if (!isAbsolute(config.helperPath)) throw new Error('dsh-cua helperPath must be absolute')
    installCua(ctx, config, { helperPath: config.helperPath, createChannel: createSharedNativeChannel, guidance: GUIDANCE, description })
    return
  }
  const architecture = nativeHostArchitecture(process.platform, process.arch)
  const controller = new AbortController()
  const prepared = prepareNativeExecutable({
    packageRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
    architecture, subprocess: ctx.subprocess,
    timeoutMs: config.buildTimeoutMs, graceMs: config.graceMs, signal: controller.signal,
  })
  ctx.effect(() => async () => {
    controller.abort()
    // The Loader receives preparation failures through apply; disposal only awaits quiescence.
    await prepared.catch(() => {})
  }, 'dsh-cua.native-preparation')
  const helperPath = await prepared
  controller.signal.throwIfAborted()
  installCua(ctx, config, { helperPath, createChannel: createSharedNativeChannel, guidance: GUIDANCE, description })
}
