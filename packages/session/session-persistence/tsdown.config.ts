import { defineConfig } from 'tsdown'

/** Keep filesystem resources separate from the backend-independent service entry. */
export default defineConfig({
  entry: ['lib/types/{index,lease,win32}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
