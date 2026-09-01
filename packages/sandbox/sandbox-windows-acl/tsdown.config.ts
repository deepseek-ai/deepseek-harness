import { defineConfig } from 'tsdown'

// The confinement runner builds as its own entry (path-loaded by
// dsh-sandbox-local's win32 chain), inlining the sandbox primitives while
// koffi stays an external native require — the same shape as
// directory-picker-native's worker entry.
export default defineConfig({
  entry: { index: 'lib/types/index.js', runner: 'lib/types/runner.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
