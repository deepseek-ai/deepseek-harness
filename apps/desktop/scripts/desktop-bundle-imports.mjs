/**
 * Keep every bare import a Desktop bundle leaves to the runtime resolvable
 * inside the packaged application.
 *
 * electron-builder copies only the manifest's `dependencies` into
 * `app.asar/node_modules`, so a bare import of anything else bundles without
 * complaint and fails at launch with `ERR_MODULE_NOT_FOUND`. The main-process
 * bundle inlines its workspace devDependencies; when one of their `lib/`
 * outputs is missing at bundle time, rolldown reports `UNRESOLVED_IMPORT` as a
 * warning and keeps the specifier as an external import, which is exactly the
 * broken artifact. This check fails the bundle instead of the installed
 * application.
 *
 * The check runs in `moduleParsed`, where rolldown reports every import record
 * of a module: static imports, dynamic `import()`, and `require()` calls. A
 * bundled import resolves to an absolute module id; an external one keeps its
 * bare specifier. Chunk metadata (`imports`/`dynamicImports`) omits external
 * `import()` and `require()` targets, so it cannot serve this check.
 */

import { isBuiltin } from 'node:module'
import { isAbsolute, relative } from 'node:path'

/**
 * Bare specifiers one Desktop bundle may leave for the runtime to resolve.
 * @typedef {object} BundleImportPolicy
 * @property {ReadonlySet<string>} packages - Package names present at runtime, matched by package name so subpaths pass.
 * @property {boolean} nodeBuiltins - Whether Node builtins resolve at runtime (true for the Electron main process; false for sandboxed preloads, whose `require` polyfill offers only the modules listed in `packages`).
 */

/**
 * Package name of a bare import specifier.
 * @param {string} specifier - Bare specifier as rolldown reports it, such as `@scope/name/subpath`.
 * @returns {string} The package name without its subpath.
 */
export function importPackageName(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

/**
 * Whether a module id rolldown reports is a bare specifier, i.e. an import the
 * bundle leaves external. Bundled modules carry absolute ids; virtual modules
 * start with `\0`.
 * @param {string} id - Module id from `importedIds` or `dynamicallyImportedIds`.
 * @returns {boolean} True for a bare specifier.
 */
export function isBareSpecifier(id) {
  return !id.startsWith('.') && !id.startsWith('\0') && !isAbsolute(id)
}

/**
 * Bare imports the packaged application cannot resolve.
 * @param {readonly string[]} imports - External specifiers a module imports statically, dynamically, or through `require()`.
 * @param {BundleImportPolicy} policy - What this bundle may leave external.
 * @returns {string[]} Offending specifiers in import order, each once.
 */
export function unpackagedImports(imports, policy) {
  const offending = new Set()
  for (const specifier of imports) {
    if (policy.nodeBuiltins && isBuiltin(specifier)) continue
    if (policy.packages.has(importPackageName(specifier))) continue
    offending.add(specifier)
  }
  return [...offending]
}

/**
 * Rolldown plugin that fails a bundle whose external imports the packaged
 * application cannot resolve. The failure names the importing module and every
 * offending specifier, and no output is written.
 * @param {BundleImportPolicy} policy - What this bundle may leave external.
 * @returns {import('tsdown').Rolldown.Plugin} The plugin.
 */
export function packagedImportsPlugin(policy) {
  const allowed = [...policy.packages].join(', ') + (policy.nodeBuiltins ? ', and Node builtins' : '')
  return {
    name: 'desktop-packaged-imports',
    moduleParsed(info) {
      const external = [...info.importedIds, ...info.dynamicallyImportedIds].filter(isBareSpecifier)
      const offending = unpackagedImports(external, policy)
      if (offending.length === 0) return
      this.error(
        `desktop bundle: ${relative(process.cwd(), info.id)} imports ${offending.join(', ')}, which the packaged application does not ship. `
        + `This bundle may leave only ${allowed} as bare imports; anything else must be bundled, `
        + 'which requires its lib/ output to exist before this bundle runs (pnpm run build:lib:host).',
      )
    },
  }
}
