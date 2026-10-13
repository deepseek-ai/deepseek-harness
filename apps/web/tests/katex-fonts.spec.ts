import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import { build, loadConfigFromFile } from 'vite'
import { expect, it, onTestFinished } from 'vitest'

const require = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
const stylesheet = require.resolve('katex/dist/katex.min.css')

/** Build a stylesheet with the application's asset plugins without writing artifacts. */
async function bundleStyle(source: { path: string } | { package: string; css: string }) {
  const root = await mkdtemp(join(tmpdir(), 'katex-fonts-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  let input: string
  if ('path' in source) input = source.path
  else {
    input = join(root, 'node_modules', source.package, 'dist', 'katex.min.css')
    await mkdir(dirname(input), { recursive: true })
    await writeFile(input, source.css)
    await writeFile(join(dirname(input), 'font.woff'), 'fixture font')
  }
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, fileURLToPath(new URL('../vite.config.ts', import.meta.url)))
  if (!loaded) throw new Error('Expected the Web build configuration')
  // The product isolation check requires the full application's HTML entry.
  const plugins = (loaded.config.plugins ?? []).flat().filter(plugin => !(plugin && typeof plugin === 'object'
    && 'name' in plugin && plugin.name === 'dsh-product-web-bundle-isolation'))
  const result = await build({
    ...loaded.config, configFile: false, plugins,
    root, logLevel: 'silent',
    build: { write: false, cssMinify: false, assetsInlineLimit: 0, rollupOptions: { input } },
  })
  if ('on' in result) throw new Error('Expected a completed build')
  return (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output)
}

/** Normalize layout CSS independently of emitted font URLs and format fallbacks. */
function layoutCss(css: string): string {
  return transform({
    filename: 'layout.css', code: Buffer.from(css), minify: true,
    visitor: { Rule: { 'font-face'(rule) {
      rule.value.properties = rule.value.properties.filter(property => property.type !== 'source')
      return rule
    } } },
  }).code.toString()
}

it('ships all KaTeX WOFF2 faces with identical font bytes and layout styles', async () => {
  const output = await bundleStyle({ path: stylesheet })
  const fonts = output.filter(asset => asset.type === 'asset' && /\.(?:woff2?|ttf)$/u.test(asset.fileName))
  expect(fonts).toHaveLength(20)
  for (const font of fonts) {
    expect(font.fileName).toMatch(/\.woff2$/u)
    if (font.type !== 'asset') throw new Error('Expected a font asset')
    const name = font.names[0]!
    expect(Buffer.from(font.source)).toEqual(await readFile(join(dirname(stylesheet), 'fonts', name)))
  }
  const css = output.find(asset => asset.type === 'asset' && asset.fileName.endsWith('.css'))
  if (css?.type !== 'asset') throw new Error('Expected a stylesheet asset')
  const text = Buffer.from(css.source).toString()
  expect(text).not.toMatch(/\.(?:woff|ttf)["')]/u)
  expect(layoutCss(text)).toBe(layoutCss(await readFile(stylesheet, 'utf8')))
})

it.each(['src: url(font.woff) format("woff");', ''])('rejects a KaTeX face without WOFF2 (src=%s)', async (source) => {
  await expect(bundleStyle({ package: 'katex', css: `@font-face { font-family: KaTeX_Main; ${source} }` }))
    .rejects.toThrow('KaTeX font face requires a WOFF2 source')
})

it('preserves older font formats in unrelated stylesheets', async () => {
  const output = await bundleStyle({ package: 'other', css: '@font-face { font-family: Other; src: url(font.woff) format("woff"); }' })
  expect(output.some(asset => asset.type === 'asset' && asset.fileName.endsWith('.woff'))).toBe(true)
})
