import { defineConfig } from 'tsdown'

export default defineConfig(Object.entries({
  index: 'lib/types/index.js', api: 'lib/types/api.js', bridge: 'lib/types/bridge.js',
  'native-client': 'lib/types/native-client.js', protocol: 'lib/types/protocol.js',
}).map(([name, path]) => ({
  entry: { [name]: path },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})))
