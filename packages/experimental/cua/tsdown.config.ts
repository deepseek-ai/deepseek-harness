import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

const runtime: UserConfig[] = Object.entries({
  'remote-types': 'lib/types/remote-types.js', api: 'lib/types/api.js', bridge: 'lib/types/bridge.js',
  'native-client': 'lib/types/native-client.js', protocol: 'lib/types/protocol.js',
}).map(([name, path]) => ({
  entry: { [name]: path },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
}))

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], { hostPhase: true, companions: runtime })
