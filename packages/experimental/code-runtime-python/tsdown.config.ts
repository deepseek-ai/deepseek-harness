import { defineConfig } from 'tsdown'

/**
 * Single ESM bundle. The Python-side code is not TypeScript and ships verbatim
 * under `py/` (whitelisted in package.json `files`) — no build step needed.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
