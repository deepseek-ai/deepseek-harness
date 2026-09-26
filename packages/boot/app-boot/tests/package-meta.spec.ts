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

  it('uses only the package resource exported for the requested plugin address', () => {
    manifest({
      './package.json': './package.json',
      './search/package.json': './search-manifest.json',
    }, { description: 'Whole package' })
    file(join(dir, 'search-manifest.json'), JSON.stringify({ name: 'Search plugin', description: 'Search introduction' }))
    expect(readPluginMeta('localized/search', parentURL)).toEqual({ title: 'Search plugin', description: 'Search introduction' })
    expect(readPluginMeta('localized/review', parentURL)).toBeUndefined()
  })

  it.each([{}, { name: '', description: ' ' }, { name: false, description: null }])('ignores unavailable package text: %j', (fields) => {
    manifest({ './feature/package.json': './feature.json' })
    file(join(dir, 'feature.json'), JSON.stringify(fields))
    expect(readPluginMeta('localized/feature', parentURL)).toBeUndefined()
  })

  it('reports malformed fallback files', () => {
    manifest({ './feature/package.json': './feature.json' })
    file(join(dir, 'feature.json'), '{')
    expect(readPluginMeta('localized/feature', parentURL)?.error).toContain('feature.json')
  })

  it('does not hide invalid locale fields behind package text', () => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './package.json' }, { description: 'Package description' })
    dictionary('en', { meta: { title: false } })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('meta.title must be a non-empty string')
  })

  it('reads the manifest icon even when both English fields are supplied', () => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './package.json' }, { icon: './art/team.svg' })
    file(join(dir, 'art', 'team.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    dictionary('en', { meta: { title: 'Plugin', description: 'Locale introduction' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Plugin' }, description: { en: 'Locale introduction' },
      icon: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    })
  })

  it.each([
    ['svg', 'image/svg+xml'], ['png', 'image/png'], ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['SVG', 'image/svg+xml'],
  ])('encodes a package-local %s icon without executing the plugin', (extension, mediaType) => {
    manifest({ '.': './index.js', './package.json': './package.json' }, { icon: `./icon.${extension}` })
    const bytes = Buffer.from([0, 1, 127, 128, 255])
    writeFileSync(join(dir, `icon.${extension}`), bytes)
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: 'localized', icon: `data:${mediaType};base64,${bytes.toString('base64')}`,
    })
  })

  it('reads an icon-only subexport relative to its own manifest without inheriting the package icon', () => {
    manifest({ './package.json': './package.json', './search/package.json': './search/manifest.json' }, { icon: './root.png' })
    file(join(dir, 'root.png'), 'root')
    file(join(dir, 'search', 'manifest.json'), JSON.stringify({ icon: './icon.webp' }))
    file(join(dir, 'search', 'icon.webp'), 'search')
    expect(readPluginMeta('localized/search', parentURL)).toEqual({
      icon: `data:image/webp;base64,${Buffer.from('search').toString('base64')}`,
    })
    expect(readPluginMeta('localized/review', parentURL)).toBeUndefined()
  })

  it.each([null, false, 1, {}, [], '', '  '])('retains localized text while rejecting malformed icon %j', (icon) => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './package.json' }, { icon })
    dictionary('en', { meta: { title: 'Plugin', description: 'Introduction' } })
    dictionary('zh', { meta: { title: '插件' } })
    const { error, ...meta } = readPluginMeta('localized', parentURL)!
    expect(meta).toEqual({ title: { en: 'Plugin', zh: '插件' }, description: { en: 'Introduction' } })
    expect(error).toContain('icon must be a non-empty string')
  })

  it.each(['/tmp/icon.svg', 'C:\\icon.png', 'C:icon.png', '\\\\server\\share\\icon.png', 'https://example.test/icon.svg', 'data:image/svg+xml,<svg/>'])('rejects non-relative icon %s', (icon) => {
    manifest({ './package.json': './package.json' }, { icon, description: 'Introduction' })
    const { error, ...meta } = readPluginMeta('localized', parentURL)!
    expect(meta).toEqual({ title: 'localized', description: 'Introduction' })
    expect(error).toContain('icon must be a relative file path')
  })

  it.each(['icon.gif', 'icon.html', 'icon', 'icon.svg?query'])('rejects unsupported icon file %s', (icon) => {
    manifest({ './package.json': './package.json' }, { icon })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('icon must be SVG, PNG, JPEG, or WebP')
  })

  it('reports missing files, directories, and paths outside the manifest directory', () => {
    manifest({ './package.json': './package.json' }, { icon: './missing.svg' })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('missing.svg')
    mkdirSync(join(dir, 'missing.svg'))
    expect(readPluginMeta('localized', parentURL)?.error).toContain('icon must be a regular file')
    manifest({ './package.json': './package.json' }, { icon: '../localized-other/icon.svg' })
    file(join(root, 'node_modules', 'localized-other', 'icon.svg'), 'outside')
    expect(readPluginMeta('localized', parentURL)?.error).toContain('icon must remain inside its manifest directory')
  })

  it('accepts an icon at the byte limit and rejects one byte more', () => {
    manifest({ './package.json': './package.json' }, { icon: './icon.png' })
    const bytes = Buffer.alloc(256 * 1024)
    writeFileSync(join(dir, 'icon.png'), bytes)
    expect(readPluginMeta('localized', parentURL)?.icon).toBe(`data:image/png;base64,${bytes.toString('base64')}`)
    writeFileSync(join(dir, 'icon.png'), Buffer.alloc(bytes.length + 1))
    expect(readPluginMeta('localized', parentURL)?.error).toContain('icon exceeds 256 KiB')
  })

  it('rejects an icon that grows beyond the limit after its size check', () => {
    manifest({ './package.json': './package.json' }, { icon: './icon.png' })
    const icon = join(dir, 'icon.png')
    file(icon, 'small')
    const original = fs.statSync
    const stat = vi.spyOn(fs, 'statSync')
    try {
      stat.mockImplementation(new Proxy(original, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          const result: unknown = Reflect.apply(target, receiver, args)
          if (String(args[0]).endsWith(join('localized', 'icon.png'))) writeFileSync(icon, Buffer.alloc(256 * 1024 + 1))
          return result
        },
      }))
      syncBuiltinESMExports()
      expect(readPluginMeta('localized', parentURL)?.error).toContain('icon exceeds 256 KiB')
    } finally {
      stat.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it('rejects icons reached through an external directory link and accepts internal links', () => {
    manifest({ './package.json': './package.json' }, { icon: './art/icon.svg' })
    const outside = join(root, 'outside')
    file(join(outside, 'icon.svg'), 'outside')
    const link = join(dir, 'art')
    symlinkSync(outside, link, 'junction')
    try {
      expect(readPluginMeta('localized', parentURL)?.error).toContain('icon must remain inside its manifest directory')
    } finally {
      unlinkSync(link)
    }
    const inside = join(dir, 'images')
    file(join(inside, 'icon.svg'), 'inside')
    symlinkSync(inside, link, 'junction')
    try {
      expect(readPluginMeta('localized', parentURL)?.icon).toBe(`data:image/svg+xml;base64,${Buffer.from('inside').toString('base64')}`)
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
    const resolveSync = vi.fn(() => ({ url: pathToFileURL(join(dir, 'locale', 'en.json')).href }))
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
    const specifier = 'localized/locale/en.json'
    expect(resolveSync.mock.calls).toEqual(version === 'v1'
      ? [[specifier, parentURL, {}], [specifier, parentURL, {}], ['localized/package.json', parentURL, {}]]
      : [[parentURL, { specifier, attributes: {} }], [parentURL, { specifier, attributes: {} }],
        [parentURL, { specifier: 'localized/package.json', attributes: {} }]])
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
