import { defineConfig } from 'tsdown'

/**
 * Node-only host half. The `./shared` subpath (route paths and wire payload
 * types for the browser package) resolves the tsc-emitted tree directly, so
 * the bundle has a single entry.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
