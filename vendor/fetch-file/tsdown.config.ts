import { defineConfig } from 'tsdown'

// Keep conditional entries self-contained, without shared output chunks.
const shared = {
  outDir: 'lib',
  format: ['esm'],
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
} as const

export default defineConfig([
  { ...shared, platform: 'node', entry: ['lib/types/node.js'] },
  { ...shared, platform: 'browser', entry: ['lib/types/browser.js'] },
])
