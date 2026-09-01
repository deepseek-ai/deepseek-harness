import { defineConfig } from 'tsdown'

/**
 * Build the index and worker as separate single-entry bundles. The sibling `worker.cjs` is loaded
 * by file and must be CommonJS for pkg's VFS Worker hook. A multi-entry build emits an unlisted
 * shared chunk omitted by the package's exact `files` whitelist; separate builds inline it.
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
  {
    entry: ['lib/types/worker.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
