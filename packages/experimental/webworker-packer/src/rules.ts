/**
 * Pack rule tables: the one place the image's include/exclude decisions live.
 * Patterns are picomatch globs. Exclude patterns match tree-root-relative
 * paths (so `src/**` drops only a root-level source tree), page-asset
 * patterns match image paths. Traversal mechanics — nested `node_modules`
 * flattening and dot-directory pruning — stay in the collector; these tables
 * hold the judgement calls.
 */

/**
 * Paths dropped from every collected tree. Test trees, sourcemaps,
 * declarations, and archives never resolve at runtime while dominating the
 * byte count. Third-party `src/` directories remain eligible because package
 * entrypoints may resolve to JavaScript there.
 */
export const EXCLUDE: readonly string[] = [
  'tests/**',
  'test/**',
  '__tests__/**',
  'coverage/**',
  '**/*.map',
  '**/*.tsbuildinfo',
  '**/*.tgz',
  '**/*.tar',
  '**/*.tar.gz',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
]

/**
 * Additional paths dropped from workspace and vendored packages only. Their
 * runtime plane is built `lib/`; a workspace `dist/` is a page-asset tree the
 * static deployment serves itself. External packages may place runtime code
 * under either directory.
 */
export const EXCLUDE_WORKSPACE: readonly string[] = [
  'src/**',
  'dist/**',
]

/**
 * Image paths that belong to the PAGE, not to the worker's loader.
 *
 * A package's `lib/client.js` entry and `lib/client.*.js` sibling chunks are
 * browser bundles behind the `./client` export: the page's own module system evaluates them with its own wrapper,
 * which has no ambient-store parameter. Transforming those bodies would
 * inject calls the page cannot resolve, so they ship untransformed — their
 * only change is the trailing debugger-name line every JavaScript entry
 * gains — and the manifest's all-or-nothing claim stays true, because the
 * worker loader never evaluates them (the tunnel serves them as bytes).
 */
export const PAGE_ASSETS: readonly string[] = [
  'node_modules/*/lib/client.js',
  'node_modules/*/lib/client.*.js',
  'node_modules/@*/*/lib/client.js',
  'node_modules/@*/*/lib/client.*.js',
]

/**
 * Image specifiers the worker assembly requires directly, beyond the composed
 * roster: they are requested by worker-bundle code, so no image file
 * references them and the reachability sweep must seed them as roots. Keep in
 * step with the literal `require`/`resolve` calls in the runtime's
 * `worker-host.ts`.
 */
export const IMAGE_ENTRY_SEEDS: readonly string[] = [
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-include',
  'js-yaml',
]
