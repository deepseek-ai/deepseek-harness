import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

const worker: UserConfig = {
  entry: { worker: 'lib/types/worker/entry.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { inlineDynamicImports: true },
  deps: { neverBundle: specifier => specifier === 'ws' },
}

/** Build the Host plugin and Worker during the Host pass, and the dynamic Client plugin during the Client pass. */
export default clientBundle(
  '@deepseek-ai/dsh-experimental-inspector',
  ['lib/types/index.js'],
  { hostPhase: true, companions: [worker] },
)
