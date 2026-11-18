import { defineConfig } from 'tsdown'

/**
 * Two published entries: the runtime package (`lib/index.js`) and the testkit behind its `./testing` subpath
 * (`lib/testing.js`). Built together with code splitting enabled so shared runtime modules (such as `errors.ts` and
 * `PlatformError`/`PartialSendError`) are emitted once and keep a single class identity across both entrypoints.
 */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    testing: 'lib/types/testing.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
