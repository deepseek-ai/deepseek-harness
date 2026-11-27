/**
 * Shared browser platform modules. Shell seeding and client bundle externals
 * consume these lists so their module identities cannot drift.
 * @module @deepseek-ai/dsh-client-web/src/platform
 */

/**
 * Module specifiers every dynamic Client bundle requires from the module table without declaring them: the shell
 * seeds the third-party identities, Cordis, and the `staticLinked` client-store, and each other workspace package in
 * the list is a dynamic Client package with `immediately: true` that registers through its own Client row.
 */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/**
 * Named export carrying the module manifest of a `staticLinked` library. The library keeps its ordinary
 * exports; the manifest's factory returns those exports, without this one, and its `meta` describes the
 * library's compiled stylesheets.
 */
export const STATIC_MODULE_MANIFEST_EXPORT = '__$dsh_client_module_manifest'

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
] as const

/** One platform module specifier. */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
