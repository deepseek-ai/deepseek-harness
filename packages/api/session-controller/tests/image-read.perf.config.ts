/** Compile the diagnostic's private controller adapter; workspace services remain built package imports. */

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'image-read.perf': 'image-read.perf.ts' },
  outDir: '../.dsh-build/image-read',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  tsconfig: '../../../../tsconfig.base.json',
  deps: { neverBundle: [/^@deepseek-ai\//], onlyBundle: false },
})
