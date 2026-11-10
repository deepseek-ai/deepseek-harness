/** Windows C# provider for the shared Computer Use application and window API. */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { CuaConfig, installCua, type CuaStartupCapabilities } from '@deepseek-ai/dsh-cua'
import { CuaConfigFields } from '@deepseek-ai/dsh-cua/config'
import { prepareNativeExecutable, nativeHostArchitecture } from './native-build.ts'
import { WindowsNativeRuntime } from './native-runtime.ts'
import { GUIDANCE } from './guidance.ts'
import { windowsHost, prepareWsl, retainWslHelper } from './windows-host.ts'

const CAPABILITIES: CuaStartupCapabilities = {
  platform: 'windows',
  methods: [
    'getCapabilities', 'listApps', 'getApp', 'activate', 'show', 'listWindows', 'getState',
    'listActions', 'performAction', 'invoke', 'mouseMove', 'click', 'setValue', 'selectText',
    'typeText', 'paste', 'pressKey', 'scroll', 'drag', 'screenshot',
  ],
  appLevelAccessibility: false,
  keyboard: ['window'],
  browser: false,
  coordinateSpace: 'screenshot-pixels',
}

/** Loader identity of the Windows provider. */
export const name = 'cua-windows'
/** Services required by shared CUA execution and managed native preparation. */
export const inject = ['computerUse', 'tools', 'systemPrompt', 'subprocess', 'agents']

/** Windows native waiting policy, alongside shared CUA resource limits. */
export interface Config extends CuaConfig {
  /** Windows PowerShell executable used to query WSL interoperation and the Windows architecture. */
  windowsPowerShellPath: string
  /** Milliseconds between application-readiness and clipboard-release observations. */
  pollIntervalMs: number
}

/** Validate platform configuration before locating and launching the helper. */
export const Config = Schema.object({
  ...CuaConfigFields,
  connectTimeoutMs: CuaConfigFields.connectTimeoutMs.default(30_000),
  windowsPowerShellPath: Schema.string().min(1).default('powershell.exe'),
  pollIntervalMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(25),
  textEventIntervalMs: CuaConfigFields.textEventIntervalMs.default(0),
  maxRequestBytes: CuaConfigFields.maxRequestBytes.max(2 ** 31 - 1),
  maxResponseBytes: CuaConfigFields.maxResponseBytes.max(2 ** 31 - 1),
  maxClipboardBytes: CuaConfigFields.maxClipboardBytes.max(2 ** 31 - 1),
}) satisfies Schema<Record<string, unknown>, Config>

/**
 * Prepare the Windows payload and install the shared authorized operation pipeline.
 * @param ctx - Owning provider context.
 * @param config - Validated helper override, operation bounds, and application grants.
 * @returns Completion after preparation and reversible registrations.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const host = windowsHost()
  if (config.helperPath !== undefined && !isAbsolute(config.helperPath)) throw new Error('Windows CUA helperPath must be absolute')
  const controller = new AbortController()
  const prepare = async () => {
    const wsl = host === 'wsl' ? await prepareWsl({ subprocess: ctx.subprocess, signal: controller.signal,
      timeoutMs: config.connectTimeoutMs, graceMs: config.graceMs, powershellPath: config.windowsPowerShellPath }) : undefined
    let helperPath = config.helperPath
    if (helperPath === undefined) {
      const architecture = wsl?.architecture ?? nativeHostArchitecture(process.platform, process.arch)
      helperPath = await prepareNativeExecutable({
        packageRoot: resolve(fileURLToPath(new URL('..', import.meta.url))), architecture,
        subprocess: ctx.subprocess, timeoutMs: config.buildTimeoutMs, graceMs: config.graceMs, signal: controller.signal,
      })
    }
    return wsl ? retainWslHelper(helperPath, wsl.cacheDirectory, controller.signal) : helperPath
  }
  const prepared = prepare()
  ctx.effect(() => async () => {
    controller.abort()
    // Activation owns preparation failures; disposal joins the same operation.
    await prepared.catch(() => {})
  }, 'cua-windows.native-preparation')
  const helperPath = await prepared
  controller.signal.throwIfAborted()
  const runtime = new WindowsNativeRuntime(ctx, config.pollIntervalMs, host === 'wsl' ? 'stdio' : 'pipe')
  ctx.effect(() => () => runtime.dispose(), 'cua-windows.native-runtime')
  installCua(ctx, config, {
    helperPath, createChannel: (_owner, native) => runtime.connect(native), getGuidance: () => GUIDANCE, capabilities: CAPABILITIES,
    permissionParameters: (_method, permission) => ({ permission }),
  })
}
