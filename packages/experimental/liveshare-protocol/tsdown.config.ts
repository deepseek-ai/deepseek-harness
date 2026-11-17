import type { UserConfig } from 'tsdown'
import { defineConfig } from 'tsdown'

/**
 * Dependency-free code shared by the owner bundle and the Relay. The package carries two compiler
 * faces — a Host leaf for the wire codecs and identity contract, and a browser leaf for the viewer
 * carrier — but only the Host face publishes runtime modules; the carrier reaches a browser as
 * generated source text, so it needs no client bundle.
 */
export default defineConfig(({ env }) => {
  if (env?.DSH_BUILD_FACE === 'client') return { entry: '' } satisfies UserConfig
  return {
    entry: [
      'lib/types/index.js',
    ],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  } satisfies UserConfig
})
