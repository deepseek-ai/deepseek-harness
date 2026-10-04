import { defineConfig } from 'tsdown'

const entry = (path: string) => ({
  entry: [path],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
})

/** Build self-contained Loader entries so the package needs no private chunks. */
export default defineConfig([
  entry('lib/types/index.js'),
  entry('lib/types/model-selection-settings.js'),
])
