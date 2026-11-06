import { defineConfig } from 'tsdown'

/**
 * Two published entries: the runtime package (`lib/index.js`) and the testkit behind its `./testing` subpath
 * (`lib/testing.js`). The testkit is a module of its own upstream, and a package that only bundles the first entry
 * publishes an export map whose `./testing` target does not exist. Each entry is self-contained (`codeSplitting`
 * off), so a consumer importing one never pulls the other's modules.
 */
const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
} as const

export default defineConfig([
  { ...shared, entry: { index: 'lib/types/index.js' } },
  { ...shared, entry: { testing: 'lib/types/testing.js' } },
])
