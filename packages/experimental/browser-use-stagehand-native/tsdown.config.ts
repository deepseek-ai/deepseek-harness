import { defineConfig } from 'tsdown'

/** Separate bundles keep the attachment Worker loadable without source files. */
export default defineConfig(['index', 'worker'].map(entry => ({
  entry: [`lib/types/${entry}.js`],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { inlineDynamicImports: true },
})))
