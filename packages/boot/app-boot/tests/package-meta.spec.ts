/** Plugin locale resources resolve independently of entry execution and package display fields. */

import fs, { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPluginMeta, resolvePluginResource } from '../src/package-meta.ts'
import { installRuntimeInterception } from '../src/profile-resolution/resolver.ts'
import { registerHooksThreadStacks } from './hooks-thread-stack.ts'

let root: string
let dir: string
let parentURL: string

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function manifest(exports: object, extra: object = {}): void {
  file(join(dir, 'package.json'), JSON.stringify({ name: 'localized', type: 'module', exports, ...extra }))
}

function dictionary(language: string, contents: unknown, directory = join(dir, 'locale')): void {
  file(join(directory, `${language}.json`), JSON.stringify(contents))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-plugin-meta-'))
  dir = join(root, 'node_modules', 'localized')
  parentURL = pathToFileURL(join(root, 'entry.mjs')).href
  manifest({ '.': './index.js', './locale/*.json': './locale/*.json' }, { description: 'Not local display text.' })
  file(join(dir, 'index.js'), 'throw new Error("metadata must not execute the plugin")\n')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('plugin locale display metadata', () => {
  it.each([
    'C:\\plugins\\search.js',
    'C:/plugins/search.js',
    '\\\\server\\share\\plugins\\search.js',
    '//server/share/plugins/search.js',
    '.\\plugins\\search.js',
    './plugins/search.js',
    '../plugins/search.js',
    '/plugins/search.js',
    'file:///plugins/search.js',
    'file:///C:/plugins/search.js',
    'file://server/share/plugins/search.js',
  ])('does not resolve metadata resources for plugin file address %s', (specifier) => {
    const original = ModuleLoader.fromInternal
    const resolver = vi.spyOn(ModuleLoader, 'fromInternal')
    try {
      expect(readPluginMeta(specifier, parentURL)).toBeUndefined()
      expect(resolver).not.toHaveBeenCalled()
    } finally {
      resolver.mockRestore()
    }
    expect(ModuleLoader.fromInternal).toBe(original)
  })

  it('omits absent resources and absent meta fields without reading npm descriptions', () => {
    expect(readPluginMeta('localized', parentURL)).toBeUndefined()
    expect(readPluginMeta('absent', parentURL)).toBeUndefined()
    expect(readPluginMeta('node:fs', parentURL)).toBeUndefined()
    expect(readPluginMeta('fs', parentURL)).toBeUndefined()
    expect(readPluginMeta('cordis:group', parentURL)).toBeUndefined()
    dictionary('en', { other: { title: 'Not metadata' } })
    expect(readPluginMeta('localized', parentURL)).toBeUndefined()
    dictionary('en', { meta: {} })
    expect(readPluginMeta('localized', parentURL)).toBeUndefined()
  })

  it('reads direct fields, retains per-field translations, and ignores other locale content', () => {
    dictionary('en', { meta: { title: 'Team', description: 'Work together', ignored: false }, other: { nested: [1] } })
    dictionary('zh', { meta: { title: '团队' } })
    dictionary('pt-BR', { meta: { description: 'Trabalhar juntos' } })
    file(join(dir, 'locale', 'ignored.txt'), 'not JSON')
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Team', zh: '团队' },
      description: { en: 'Work together', 'pt-br': 'Trabalhar juntos' },
    })
  })

  it('treats percent markers as literal display text', () => {
    dictionary('en', { meta: { title: '%title%', description: 'Plugin %name%' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: '%title%' }, description: { en: 'Plugin %name%' },
    })
  })

  it('accepts description-only metadata and supplies the module name when a translated title has no English value', () => {
    dictionary('en', { meta: { description: 'About it' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({ description: { en: 'About it' } })
    dictionary('zh', { meta: { title: '标题' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'localized', zh: '标题' }, description: { en: 'About it' },
    })
  })

  it('never reads package.json for a subpath plugin, even when one is exported at its address', () => {
    manifest({ './search/locale/*.json': './locale/*.json', './search/package.json': './broken.json', './icon': './missing.svg' })
    file(join(dir, 'broken.json'), '{')
    dictionary('en', { meta: { title: 'Search' } })
    expect(readPluginMeta('localized/search', parentURL)).toEqual({ title: { en: 'Search' } })
  })

  it.each([undefined, null])('keeps a bundle with exports=%j manageable without an icon', (exports) => {
    file(join(dir, 'package.json'), JSON.stringify({ name: 'localized', description: 'Plain bundle', type: 'module', exports }))
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: 'localized', description: 'Plain bundle' })
  })

  it('falls back to package fields when locale resources are absent', () => {
    manifest({ '.': './index.js', './package.json': './package.json' }, { description: 'Package introduction' })
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: 'localized', description: 'Package introduction' })
  })

  it('falls back per field without replacing available locale translations', () => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './package.json' }, { description: 'Package introduction' })
    dictionary('en', { meta: { title: 'English title' } })
    dictionary('zh', { meta: { description: '中文介绍' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'English title' }, description: { en: 'Package introduction', zh: '中文介绍' },
    })
    dictionary('en', { meta: { description: 'English introduction' } })
    dictionary('zh', { meta: { title: '中文标题' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'localized', zh: '中文标题' }, description: { en: 'English introduction' },
    })
    dictionary('en', {})
    dictionary('zh', {})
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: 'localized', description: 'Package introduction' })
  })

  it('retains non-English descriptions with an empty final English fallback', () => {
    dictionary('en', { meta: { title: 'Plugin' } })
    dictionary('zh', { meta: { description: '中文介绍' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Plugin' }, description: { en: '', zh: '中文介绍' },
    })
  })

  it('reads a subpath icon only from the resource exported at that plugin address', () => {
    manifest({ './package.json': './package.json', './icon': './root.svg', './search/icon': './search.svg' }, { icon: './root.svg' })
    file(join(dir, 'root.svg'), 'root')
    file(join(dir, 'search.svg'), 'search')
    expect(readPluginMeta('localized/search', parentURL)).toEqual({
      icon: `data:image/svg+xml;base64,${Buffer.from('search').toString('base64')}`,
    })
    expect(readPluginMeta('localized/review', parentURL)).toBeUndefined()
  })

  it.each([{}, { name: '', description: ' ' }, { name: false, description: null }])('ignores unavailable package text: %j', (fields) => {
    manifest({ './package.json': './feature.json' })
    file(join(dir, 'feature.json'), JSON.stringify(fields))
    expect(readPluginMeta('localized', parentURL)).toBeUndefined()
  })

  it('reports malformed package manifests', () => {
    manifest({ './package.json': './feature.json' })
    file(join(dir, 'feature.json'), '{')
    expect(readPluginMeta('localized', parentURL)?.error).toContain('feature.json')
  })

  it('does not hide invalid locale fields behind package text', () => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './package.json' }, { description: 'Package description' })
    dictionary('en', { meta: { title: false } })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('meta.title must be a non-empty string')
  })

  it.each([undefined, './fallback.svg', '../invalid.svg'])('prefers the manifest icon to export %j', (fallback) => {
    manifest({ './package.json': './package.json', './icon': fallback }, { icon: './legacy.svg' })
    file(join(dir, 'legacy.svg'), 'legacy')
    file(join(dir, 'fallback.svg'), 'fallback')
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: 'localized', icon: `data:image/svg+xml;base64,${Buffer.from('legacy').toString('base64')}`,
    })
  })

  it('reads a legacy icon without an exports map', () => {
    file(join(dir, 'package.json'), JSON.stringify({ name: 'localized', type: 'module', icon: 'legacy.svg' }))
    file(join(dir, 'legacy.svg'), 'legacy')
    expect(readPluginMeta('localized', parentURL)?.icon)
      .toBe(`data:image/svg+xml;base64,${Buffer.from('legacy').toString('base64')}`)
  })

  it('resolves a legacy icon relative to its remapped exported manifest', () => {
    manifest({ './package.json': './display/manifest.json', './icon': './fallback.svg' })
    file(join(dir, 'display', 'manifest.json'), JSON.stringify({ icon: './logo.svg' }))
    file(join(dir, 'display', 'logo.svg'), 'remapped')
    file(join(dir, 'fallback.svg'), 'fallback')
    expect(readPluginMeta('localized', parentURL)).toEqual({
      icon: `data:image/svg+xml;base64,${Buffer.from('remapped').toString('base64')}`,
    })
  })

  it('keeps legacy icons confined to the declaring manifest directory', () => {
    manifest({ './package.json': './display/manifest.json', './icon': './fallback.svg' })
    file(join(dir, 'display', 'manifest.json'), JSON.stringify({ icon: '../outside.svg' }))
    file(join(dir, 'outside.svg'), 'outside')
    file(join(dir, 'fallback.svg'), 'fallback')
    const meta = readPluginMeta('localized', parentURL)
    expect(meta?.error).toContain(`${join(dir, 'display', 'manifest.json')}: icon must remain inside its manifest directory`)
    expect(meta?.icon).toBeUndefined()
  })

  it.each([null, false, 1, '', ' ', '/tmp/icon.svg', 'C:/icons/icon.svg', 'https://example.test/icon.svg'])
  ('does not fall through an invalid manifest icon %j', (icon) => {
    manifest({ './package.json': './package.json', './icon': './fallback.svg' }, { icon })
    file(join(dir, 'fallback.svg'), 'fallback')
    const meta = readPluginMeta('localized', parentURL)
    expect(meta?.title).toBe('localized')
    expect(meta?.error).toBeDefined()
    expect(meta?.icon).toBeUndefined()
  })

  it.each(['missing.svg', 'directory.svg', 'oversized.svg', 'unsupported.gif'])
  ('does not replace an unreadable or invalid legacy image %s with the export', (icon) => {
    manifest({ './package.json': './package.json', './icon': './fallback.svg' }, { icon })
    file(join(dir, 'fallback.svg'), 'fallback')
    mkdirSync(join(dir, 'directory.svg'))
    file(join(dir, 'oversized.svg'), 'x'.repeat(256 * 1024 + 1))
    file(join(dir, 'unsupported.gif'), 'gif')
    const meta = readPluginMeta('localized', parentURL)
    expect(meta?.title).toBe('localized')
    expect(meta?.error).toBeDefined()
    expect(meta?.icon).toBeUndefined()
  })

  it('reads the exported bundle icon even when both English fields are supplied', () => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './package.json', './icon': './art/team.svg' })
    file(join(dir, 'art', 'team.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    dictionary('en', { meta: { title: 'Plugin', description: 'Locale introduction' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Plugin' }, description: { en: 'Locale introduction' },
      icon: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    })
  })

  it.each(['manifest', 'export'])('reads a package-owned %s icon when the archive cannot realpath regular files', (source) => {
    manifest({ './package.json': './package.json', './icon': './icon.svg' }, source === 'manifest' ? { icon: './icon.svg' } : {})
    const icon = join(dir, 'icon.svg')
    file(icon, '<svg/>')
    // The executable resolver supplies module URLs independently of archive file realpath support.
    resolvePluginResource('localized/icon', parentURL)
    const original = fs.realpathSync
    const previousPkg = Object.getOwnPropertyDescriptor(process, 'pkg')
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    fs.realpathSync = new Proxy(original, {
      apply(target, receiver: unknown, args: unknown[]): unknown {
        if (String(args[0]).endsWith(join('localized', 'icon.svg'))) {
          throw Object.assign(new Error('archive-backed icon has no realpath entry'), { code: 'ENOENT' })
        }
        return Reflect.apply(target, receiver, args)
      },
    })
    syncBuiltinESMExports()
    try {
      expect(() => fs.realpathSync(icon)).toThrow('archive-backed')
      expect(readPluginMeta('localized', parentURL)).toEqual({ title: 'localized', icon: 'data:image/svg+xml;base64,PHN2Zy8+' })
    } finally {
      fs.realpathSync = original
      if (previousPkg === undefined) Reflect.deleteProperty(process, 'pkg')
      else Object.defineProperty(process, 'pkg', previousPkg)
      syncBuiltinESMExports()
    }
  })

  it.each(['manifest', 'export'])('refuses a %s icon file symlink owned by another package', (source) => {
    manifest({ './package.json': './package.json', './icon': './icon.svg' }, source === 'manifest' ? { icon: './icon.svg' } : {})
    const foreign = join(root, 'foreign-package', 'icon.svg')
    file(foreign, '<svg/>')
    file(join(root, 'foreign-package', 'package.json'), '{"name":"foreign-package"}')
    symlinkSync(foreign, join(dir, 'icon.svg'), 'file')
    const meta = readPluginMeta('localized', parentURL)
    expect(meta?.icon).toBeUndefined()
    expect(meta?.error).toContain(source === 'manifest' ? 'icon must remain inside its manifest directory' : 'icon must remain inside its package directory')
  })

  it.each([
    ['svg', 'image/svg+xml'], ['png', 'image/png'], ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['SVG', 'image/svg+xml'],
  ])('encodes a package-local %s icon without executing the plugin', (extension, mediaType) => {
    manifest({ '.': './index.js', './package.json': './package.json', './icon': `./icon.${extension}` })
    const bytes = Buffer.from([0, 1, 127, 128, 255])
    writeFileSync(join(dir, `icon.${extension}`), bytes)
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: 'localized', icon: `data:${mediaType};base64,${bytes.toString('base64')}`,
    })
  })

  it.each(['./assets/logo.webp', { import: './assets/logo.webp', default: './missing.gif' }])('reads an independent icon using the Node-selected export %j', (icon) => {
    manifest({ './icon': icon })
    file(join(dir, 'assets', 'logo.webp'), 'image')
    expect(readPluginMeta('localized', parentURL)).toEqual({
      icon: `data:image/webp;base64,${Buffer.from('image').toString('base64')}`,
    })
  })

  it.each([false, 1, '', '/tmp/icon.svg', '../icon.svg', 'https://example.test/icon.svg'])('reports invalid exported icon target %j while retaining text', (icon) => {
    manifest({ './locale/*.json': './locale/*.json', './icon': icon })
    dictionary('en', { meta: { title: 'Plugin' } })
    const meta = readPluginMeta('localized', parentURL)
    expect(meta?.title).toEqual({ en: 'Plugin' })
    expect(meta?.error).toBeDefined()
  })

  it.each(['icon.gif', 'icon.html', 'icon'])('rejects unsupported icon file %s', (icon) => {
    manifest({ './package.json': './package.json', './icon': `./${icon}` })
    file(join(dir, icon), 'unsupported')
    expect(readPluginMeta('localized', parentURL)?.error).toContain('icon must be SVG, PNG, JPEG, or WebP')
  })

  it('treats a missing icon target like a missing locale file and reports a directory target', () => {
    manifest({ './icon': './missing.svg' })
    expect(readPluginMeta('localized', parentURL)).toBeUndefined()
    mkdirSync(join(dir, 'missing.svg'))
    expect(readPluginMeta('localized', parentURL)?.error).toContain('Directory import')
  })

  it('accepts an icon at the byte limit and rejects one byte more', () => {
    manifest({ './package.json': './package.json', './icon': './icon.png' })
    const bytes = Buffer.alloc(256 * 1024)
    writeFileSync(join(dir, 'icon.png'), bytes)
    expect(readPluginMeta('localized', parentURL)?.icon).toBe(`data:image/png;base64,${bytes.toString('base64')}`)
    writeFileSync(join(dir, 'icon.png'), Buffer.alloc(bytes.length + 1))
    expect(readPluginMeta('localized', parentURL)?.error).toContain('icon exceeds 256 KiB')
  })

  it.each(['growth', 'directory'])('rejects an icon changed after resolution: %s', (change) => {
    manifest({ './package.json': './package.json', './icon': './icon.png' })
    const icon = join(dir, 'icon.png')
    file(icon, 'small')
    const original = fs.statSync
    const stat = vi.spyOn(fs, 'statSync')
    try {
      stat.mockImplementation(new Proxy(original, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          const ownIcon = String(args[0]).endsWith(join('localized', 'icon.png'))
          if (ownIcon && change === 'directory') {
            unlinkSync(icon)
            mkdirSync(icon)
          }
          const result: unknown = Reflect.apply(target, receiver, args)
          if (ownIcon && change === 'growth') writeFileSync(icon, Buffer.alloc(256 * 1024 + 1))
          return result
        },
      }))
      syncBuiltinESMExports()
      expect(readPluginMeta('localized', parentURL)?.error)
        .toContain(change === 'growth' ? 'icon exceeds 256 KiB' : 'icon must be a regular file')
    } finally {
      stat.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it.each(['inside', 'outside'])('checks an icon reached through a directory link %s the package', (location) => {
    manifest({ './icon': './art/icon.svg' })
    const destination = join(location === 'inside' ? dir : root, 'art-target')
    file(join(destination, 'icon.svg'), location)
    file(join(destination, 'package.json'), JSON.stringify({ name: 'nested' }))
    const link = join(dir, 'art')
    symlinkSync(destination, link, 'junction')
    try {
      const meta = readPluginMeta('localized', parentURL)
      if (location === 'outside') expect(meta?.error).toContain('icon must remain inside its package directory')
      else expect(meta?.icon).toBe(`data:image/svg+xml;base64,${Buffer.from(location).toString('base64')}`)
    } finally {
      unlinkSync(link)
    }
  })

  it('keeps separate plugin exports independent even when their JavaScript entries share a directory', () => {
    manifest({
      './search': './lib/search.js', './review': './lib/review.js',
      './search/locale/*.json': './resources/search/*.json',
      './review/locale/*.json': './resources/review/*.json',
      './locale/*.json': './locale/*.json',
    })
    file(join(dir, 'lib', 'search.js'), 'throw new Error("must not execute search")\n')
    file(join(dir, 'lib', 'review.js'), 'throw new Error("must not execute review")\n')
    dictionary('en', { meta: { title: 'Whole package' } })
    dictionary('en', { meta: { title: 'Search' } }, join(dir, 'resources', 'search'))
    dictionary('zh', { meta: { title: '搜索' } }, join(dir, 'resources', 'search'))
    dictionary('en', { meta: { title: 'Review' } }, join(dir, 'resources', 'review'))
    expect(readPluginMeta('localized/search', parentURL)).toEqual({ title: { en: 'Search', zh: '搜索' } })
    expect(readPluginMeta('localized/review', parentURL)).toEqual({ title: { en: 'Review' } })
    expect(readPluginMeta('localized/private', parentURL)).toBeUndefined()
  })

  it('reads scoped package roots and subexports at their complete addresses', () => {
    const scoped = join(root, 'node_modules', '@scope', 'localized')
    file(join(scoped, 'package.json'), JSON.stringify({
      name: '@scope/localized',
      exports: { './locale/*.json': './locale/*.json', './search/locale/*.json': './search-locale/*.json' },
    }))
    dictionary('en', { meta: { title: 'Scoped package' } }, join(scoped, 'locale'))
    dictionary('en', { meta: { title: 'Scoped search' } }, join(scoped, 'search-locale'))
    expect(readPluginMeta('@scope/localized', parentURL)).toEqual({ title: { en: 'Scoped package' } })
    expect(readPluginMeta('@scope/localized/search', parentURL)).toEqual({ title: { en: 'Scoped search' } })
  })

  it('uses ESM import conditions for locale exports without loading JSON modules', () => {
    manifest({ './locale/*.json': { import: './esm/*.json', require: './cjs/*.json' } })
    dictionary('en', { meta: { title: 'ESM' } }, join(dir, 'esm'))
    dictionary('en', { meta: { title: 'CJS' } }, join(dir, 'cjs'))
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: { en: 'ESM' } })
  })

  it('does not read unexported language files directly from the resolved English directory', () => {
    manifest({ './locale/en.json': './locale/en.json' })
    dictionary('en', { meta: { title: 'English' } })
    dictionary('zh', { meta: { title: '中文' } })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('./locale/zh.json')
  })

  it('reports language resources mapped outside their English directory', () => {
    manifest({ './locale/*.json': './locale/*.json', './locale/zh.json': './separate/zh.json' })
    dictionary('en', { meta: { title: 'English' } })
    dictionary('zh', { meta: { title: 'Local Chinese' } })
    dictionary('zh', { meta: { title: 'Mapped Chinese' } }, join(dir, 'separate'))
    expect(readPluginMeta('localized', parentURL)?.error).toContain('must share the English locale directory')
  })

  it('resolves same-named packages independently under each importing parent', () => {
    dictionary('en', { meta: { title: 'First' } })
    const second = join(root, 'second', 'node_modules', 'localized')
    file(join(second, 'package.json'), JSON.stringify({ name: 'localized', exports: { './locale/*.json': './locale/*.json' } }))
    dictionary('en', { meta: { title: 'Second' } }, join(second, 'locale'))
    const secondParent = pathToFileURL(join(root, 'second', 'entry.mjs')).href
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: { en: 'First' } })
    expect(readPluginMeta('localized', secondParent)).toEqual({ title: { en: 'Second' } })
  })

  it.each([null, [], false, 1, 'text'])('reports malformed meta: %j', (meta) => {
    dictionary('en', { meta })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('meta must be an object')
  })

  it.each([null, false, 1, {}, '', '  '])('reports a malformed display field: %j', (title) => {
    dictionary('en', { meta: { title } })
    const localeFile = resolvePluginResource('localized/locale/en.json', parentURL)
    expect(readPluginMeta('localized', parentURL)?.error).toContain(localeFile + ': meta.title must be a non-empty string')
  })

  it.each([[], null, 'text'])('rejects a non-object locale document: %j', (contents) => {
    dictionary('en', contents)
    expect(readPluginMeta('localized', parentURL)?.error).toContain('en.json must be an object')
  })

  it('reports malformed JSON and invalid language filenames', () => {
    dictionary('en', { meta: { title: 'Title' } })
    file(join(dir, 'locale', 'zh.json'), '{')
    expect(readPluginMeta('localized', parentURL)?.error).toContain('zh.json')
    rmSync(join(dir, 'locale', 'zh.json'))
    dictionary('not_a_language', { meta: { title: 'Title' } })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('not_a_language.json must use a language id')
  })

  it('reports invalid export targets instead of treating them as absent metadata', () => {
    manifest({ './locale/*.json': '../outside/*.json' })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('Invalid "exports" target')
  })

  it('reports an unavailable Node resolver without changing plugin state', () => {
    vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(undefined)
    expect(readPluginMeta('localized', parentURL)?.error).toContain('requires the Node module resolver')
  })

  it.each(['v1', 'v2'] as const)('uses the %s Node resolver argument order', (version) => {
    const loader = ModuleLoader.fromInternal()!
    dictionary('en', { meta: { title: 'Resolved resource', description: 'Resolved introduction' } })
    const resolveSync = vi.fn((...args: unknown[]) => {
      const request = version === 'v1' ? args[0] : (args[1] as { specifier: string }).specifier
      if (request !== 'localized/locale/en.json') throw Object.assign(new Error(`${String(request)} is not exported`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
      return { url: pathToFileURL(join(dir, 'locale', 'en.json')).href }
    })
    const adapted = new Proxy(loader, {
      get(target, property) {
        if (property === 'version') return version
        if (property === 'resolveSync') return resolveSync
        const value: unknown = Reflect.get(target, property)
        return value
      },
    })
    vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(adapted)
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Resolved resource' }, description: { en: 'Resolved introduction' },
    })
    const requests = ['localized/locale/en.json', 'localized/locale/en.json', 'localized/package.json', 'localized/icon']
    expect(resolveSync.mock.calls).toEqual(requests.map(specifier => version === 'v1'
      ? [specifier, parentURL, {}]
      : [parentURL, { specifier, attributes: {} }]))
  })

  it('rejects case-equivalent language names in a directory listing', () => {
    dictionary('en', { meta: { title: 'Title' } })
    const localeDir = dirname(resolvePluginResource('localized/locale/en.json', parentURL))
    const original = fs.readdirSync
    const english = original(localeDir, { withFileTypes: true })[0]!
    const duplicate = original(localeDir, { withFileTypes: true })[0]!
    duplicate.name = 'EN.json'
    // Case-insensitive filesystems cannot store both names in the same directory.
    const listing = vi.spyOn(fs, 'readdirSync')
    try {
      listing.mockImplementation(new Proxy(original, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          if (args[0] === localeDir) return [english, duplicate]
          return Reflect.apply(target, receiver, args)
        },
      }))
      syncBuiltinESMExports()
      expect(fs.readdirSync(dir, { withFileTypes: true })).toEqual(original(dir, { withFileTypes: true }))
      expect(readPluginMeta('localized', parentURL)?.error).toContain('localized/locale/EN.json duplicates locale en')
    } finally {
      listing.mockRestore()
      syncBuiltinESMExports()
    }
    expect(fs.readdirSync).toBe(original)
    expect(readdirSync).toBe(original)
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: { en: 'Title' } })
  })

  it('rejects case-equivalent language files on case-sensitive filesystems', (context) => {
    dictionary('en', { meta: { title: 'Title' } })
    dictionary('EN', { meta: { title: 'Other' } })
    // Case-insensitive filesystems cannot hold both filenames.
    if (readdirSync(join(dir, 'locale')).length !== 2) context.skip()
    expect(readPluginMeta('localized', parentURL)?.error).toContain('duplicates locale en')
  })
})

describe('plugin display metadata with read-only resolver stacks', () => {
  const cleanups: (() => void)[] = []
  let bundle: string
  let profileURL: string

  beforeEach(() => {
    bundle = join(root, 'bundle')
    file(join(bundle, 'package.json'), JSON.stringify({ name: 'bundle', dependencies: { plain: '*', translated: '*' } }))
    file(join(bundle, 'node_modules', 'plain', 'package.json'), JSON.stringify({
      name: 'plain', description: 'Plain introduction', exports: { '.': './index.js', './package.json': './package.json' },
    }))
    file(join(bundle, 'node_modules', 'translated', 'package.json'), JSON.stringify({
      name: 'translated', exports: { '.': './index.js', './locale/*.json': './locale/*.json', './package.json': './package.json' },
    }))
    dictionary('en', { meta: { title: 'Translated' } }, join(bundle, 'node_modules', 'translated', 'locale'))
    const profilesDir = join(root, 'profiles')
    const profileDir = join(profilesDir, 'web')
    mkdirSync(profileDir, { recursive: true })
    profileURL = `${pathToFileURL(profileDir).href}/`
    const registration = installRuntimeInterception({
      profilesDir, profileDir, localPackageNames: [], linkedRoots: [],
      entries: ['plain', 'translated'].map(name => ({
        name, version: undefined, scope: 'profile' as const,
        packageDir: join(bundle, 'node_modules', name), declarer: join(bundle, 'package.json'),
      })),
    })
    cleanups.push(() => { registration.dispose() })
    const hooks = registerHooksThreadStacks()
    cleanups.push(() => { hooks.deregister() })
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  })

  function parentFor(lookup: 'profile' | 'native'): string {
    return lookup === 'profile' ? profileURL : pathToFileURL(join(bundle, 'entry.mjs')).href
  }

  it.each(['profile', 'native'] as const)('falls back to package fields when %s resolution finds no locale resources', (lookup) => {
    expect(readPluginMeta('plain', parentFor(lookup))).toEqual({ title: 'plain', description: 'Plain introduction' })
  })

  it.each(['profile', 'native'] as const)('reads exported locale resources through %s resolution', (lookup) => {
    expect(readPluginMeta('translated', parentFor(lookup))).toEqual({ title: { en: 'Translated' } })
  })

  it('reports invalid export targets reached through the profile', () => {
    file(join(bundle, 'node_modules', 'plain', 'package.json'), JSON.stringify({
      name: 'plain', exports: { './locale/*.json': '../outside/*.json' },
    }))
    expect(readPluginMeta('plain', profileURL)?.error).toContain('Invalid "exports" target')
  })
})
