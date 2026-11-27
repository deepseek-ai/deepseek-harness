import { defineConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

const bundle = clientBundle(import.meta.dirname, ['lib/types/index.js'], { hostPhase: true })
export default defineConfig(options => bundle(options).map(config => config.platform === 'browser' ? {
  ...config,
  inputOptions: { ...config.inputOptions, resolve: { ...config.inputOptions?.resolve, mainFields: ['browser', 'module', 'main'] } },
} : config))
