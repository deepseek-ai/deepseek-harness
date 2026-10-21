import { defineConfig } from 'tsdown'

/** Embed the patched OAR implementation in the published provider. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [{
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { alwaysBundle: [/^@botiverse\/oar(?:\/|$)/] },
  outputOptions: { inlineDynamicImports: true },
}])
