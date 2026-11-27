/**
 * Host entry of the `@deepseek-ai/dsh-client-ui-primitives` package root: the empty `apply` of its `immediately` Client row.
 *
 * `tsconfig.base.json` maps the package root to the `src` directory, as for every Client package, and this directory
 * has no `index.ts`, so tsx, which runs the source-launched Host, resolves the package root to this file and the Host
 * Loader never evaluates `client/index.ts`, whose stylesheet imports only a browser bundle can load. The package's
 * exports are its `/client` subpath. tsdown builds this file into `lib/index.js`, the built package root.
 * @module @deepseek-ai/dsh-client-ui-primitives
 */

/** Host plugin body of the `immediately` Client row, which has no Host behavior. */
export function apply() {}
