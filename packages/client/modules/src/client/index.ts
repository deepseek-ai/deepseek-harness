/**
 * Browser half (the standard `./client` export): the module-system class and
 * wire contract, plus the enrollment plugin face. The module system itself is
 * built by the shell kernel BEFORE cordis exists (the bootstrap exception —
 * the mechanism that loads plugins cannot arrive through itself). The host
 * parser-preloads this ordinary client bundle into the pending registration
 * queue. The HTML-installed loader facade materializes this bundle and calls
 * its bootstrap export, which constructs the system and retains the same
 * exports for this package's graph row. The plugin face enrolls the module
 * system attached to its own Loader as `ctx.modules`.
 * @module @deepseek-ai/dsh-client-modules/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { ClientModuleSystem } from './system.ts'
import { parseBootManifest } from './manifest.ts'
import type {
  ClientBootstrapModule, ClientModuleCreateOptions, ClientModuleLoader, ClientModuleLoaderTarget,
} from './manifest.ts'

export { ClientModuleSystem }
export { exactPackageSpecifier, parseBootManifest, parseDshClient, stripClientSuffix } from './manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, ClientBootstrapModule, ClientBundleRegistration,
  ClientModuleCreateOptions, ClientModuleLoader, ClientModuleLoaderTarget, ClientModuleRecord,
  ClientModuleSystemOptions, DshWindow,
  WebBootEntry, WebBootGraph,
} from './manifest.ts'

/**
 * Build the live module system from the HTML facade's materialized modules bundle.
 * @param target - Stable registration facade whose pending queue becomes the live sink.
 * @param bootstrapModule - This bundle's id and already-materialized exports.
 * @param options - Raw boot graph, platform seed, and optional bundle transport.
 * @returns The created module system.
 */
export function createClientModuleSystem(
  target: ClientModuleLoaderTarget,
  bootstrapModule: ClientBootstrapModule,
  options: ClientModuleCreateOptions,
): ClientModuleSystem {
  return new ClientModuleSystem({
    manifest: parseBootManifest(options.boot),
    staticModules: options.staticModules,
    registrationTarget: target,
    bootstrapModule,
    ...(options.loadBundle === undefined ? {} : { loadBundle: options.loadBundle }),
  })
}

/** Required service: the Loader whose internal module system this plugin publishes. */
export const inject = ['loader']

/**
 * Enroll the kernel-built module system as `ctx.modules`.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const loader: Loader = ctx.loader
  const modules = loader.internal as unknown as ClientModuleLoader | undefined
  if (modules?.version !== 'client') {
    throw new Error('client-modules: the Loader has no client module system')
  }
  ctx.reflect.provide('modules', modules)
}
