import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'lib/types/index.js', 'run-code': 'lib/types/run-code.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { chunkFileNames: '_chunks/[name]-[hash].js' },
})
