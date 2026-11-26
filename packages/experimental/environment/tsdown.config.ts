import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import { ENVIRONMENT_PROTOCOL_VERSION } from './src/protocol.ts'

const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as { version: string }
const { engines } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { engines: { node: string } }
const daemonBanner = `// dsh-environment-daemon ${JSON.stringify({ version, protocol: ENVIRONMENT_PROTOCOL_VERSION, node: engines.node })}`

const shared = { outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false } as const

export default defineConfig([
  { ...shared, entry: { index: 'lib/types/index.js' } },
  // The daemon is copied alone to the remote machine, so it bundles every dependency.
  { ...shared, entry: { daemon: 'lib/types/daemon-entry.js' }, noExternal: [/.*/], outputOptions: { inlineDynamicImports: true, banner: daemonBanner } },
])
