import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // The Markdown parser is embedded: installed, a Host in a Web Worker resolves its browser build, which reads `document`.
  deps: { alwaysBundle: [/^(?:mdast-util-from-markdown|mdast-util-gfm|micromark-extension-gfm)(?:\/|$)/] },
})
