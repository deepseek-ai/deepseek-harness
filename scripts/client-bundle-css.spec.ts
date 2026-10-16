/**
 * Stylesheets and images enter client bundles through plugin loaders, which
 * must register their physical files as watch dependencies.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientBundle } from '../packages/client/tsdown.client.ts'

interface BundlePlugin {
  name: string
  resolveId?: (source: string, importer?: string) => string | null
  load?: (this: { addWatchFile(id: string): void }, id: string) => Promise<string | null>
}

function bundlePlugin(name: 'dsh-css-modules-inline' | 'dsh-css-global-inline' | 'dsh-css-text-inline' | 'dsh-image-inline'): BundlePlugin {
  const configs = clientBundle(
    join(import.meta.dirname, '../packages/client/ui-sidebar'),
    ['lib/types/index.js'],
  )({ env: { DSH_BUILD_FACE: 'client' } })
  const client = configs.find(config => config.platform === 'browser')
  if (client === undefined) throw new Error('client config missing')
  const plugins = (client as { plugins: BundlePlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === name)
  if (plugin === undefined) throw new Error(`${name} missing from client config`)
  return plugin
}

describe('client bundle CSS Modules', () => {
  it('registers the source stylesheet as a watch dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-watch-'))
    try {
      const stylesheet = join(root, 'Fixture.module.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, '.root { color: red; }\n')
      const plugin = bundlePlugin('dsh-css-modules-inline')
      const virtualId = plugin.resolveId?.('./Fixture.module.css', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('CSS Modules plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('data-plugin-css')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('client bundle global CSS', () => {
  it('compiles a side-effect stylesheet into a watched style injector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-global-css-watch-'))
    try {
      const stylesheet = join(root, 'base.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, 'body { color: red; }\n')
      const plugin = bundlePlugin('dsh-css-global-inline')
      const virtualId = plugin.resolveId?.('./base.css', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('global CSS plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('data-plugin-css')
      expect(output).toContain('body{color:red}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('compiles inline stylesheets as watched text without a module side effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-inline-css-watch-'))
    try {
      const stylesheet = join(root, 'base.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, 'body { color: red; }\n')
      const plugin = bundlePlugin('dsh-css-text-inline')
      const virtualId = plugin.resolveId?.('./base.css?inline', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('inline CSS plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('export default "body{color:red}"')
      expect(output).not.toContain('data-plugin-css')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('client bundle images', () => {
  it('embeds an imported image as a watched data URL and ignores other modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-image-watch-'))
    try {
      const image = join(root, 'preview.svg')
      const importer = join(root, 'index.ts')
      await writeFile(image, '<svg/>')
      const plugin = bundlePlugin('dsh-image-inline')
      const id = plugin.resolveId?.('./preview.svg', importer)
      if (typeof id !== 'string' || plugin.load === undefined) throw new Error('image plugin hooks are incomplete')
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: file => watched.push(file) }, id)

      expect(watched).toEqual([image])
      expect(output).toBe(`export default "data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}";`)
      expect(plugin.resolveId?.('./index.ts', importer)).toBeNull()
      expect(await plugin.load.call({ addWatchFile: file => watched.push(file) }, importer)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
