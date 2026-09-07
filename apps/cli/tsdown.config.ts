import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships one entry: the `bin` referenced by package.json `bin`.
 * The root tsdown builds only `lib/types/index.js`, so this override points at
 * `lib/types/bin.js` instead; its reachable mode modules bundle with it.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
})
