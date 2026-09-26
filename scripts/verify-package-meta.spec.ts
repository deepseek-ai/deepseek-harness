/** Plugin metadata checks use private source-only packages and real resource exports. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { packageMetaProblems } from './verify-package-meta.ts'

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-meta-gate-'))
  dir = join(root, 'packages', 'test', 'plugin')
  mkdirSync(dir, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function file(path: string, contents: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), contents)
}

function json(path: string, contents: unknown): void {
  file(path, JSON.stringify(contents))
}

function manifest(fields: object = {}): void {
  json('package.json', {
    name: '@test/plugin',
    description: 'Package description',
    type: 'module',
    exports: { '.': './lib/index.js', './package.json': './package.json', './locale/*.json': './locale/*.json' },
    files: ['lib', 'locale'],
    ...fields,
  })
}

it('rejects an empty workspace package corpus', () => {
  expect(packageMetaProblems(root).join('\n')).toContain('no workspace package manifests')
})

it('does not require locale resources for exported package name and description', () => {
  manifest({ exports: { '.': './lib/index.js', './package.json': './package.json' }, files: ['lib'] })
  expect(packageMetaProblems(root)).toEqual([])
})

it.each([undefined, ['art'], ['art/*.svg'], ['./art/icon.svg']])('accepts a published package icon without locale resources: %j', (files) => {
  manifest({ icon: './art/icon.svg', files })
  file('art/icon.svg', '<svg/>')
  expect(packageMetaProblems(root)).toEqual([])
})

it.each([{ files: ['lib'] }, { files: ['art', '!art/icon.svg'] }])('rejects an icon omitted from package publication: %j', ({ files }) => {
  manifest({ icon: './art/icon.svg', files })
  file('art/icon.svg', '<svg/>')
  expect(packageMetaProblems(root).join('\n')).toContain('files must include art/icon.svg')
})

it.each([null, false, 1, '', './icon.gif', '/tmp/icon.svg', './missing.png', '../outside.svg'])('validates icon declarations without locale resources: %j', (icon) => {
  manifest({ icon })
  file('../outside.svg', '<svg/>')
  expect(packageMetaProblems(root).join('\n')).toContain('Plugin metadata for @test/plugin:')
})

it('requires the root icon declaration to be exported', () => {
  manifest({ icon: './icon.svg', exports: { '.': './entry.js' }, files: ['icon.svg'] })
  file('icon.svg', '<svg/>')
  expect(packageMetaProblems(root).join('\n')).toContain('exports must expose its icon declaration through @test/plugin/package.json')
})

it.each([
  { './search/package.json': './resources/search/manifest.json' },
  { './*/package.json': './resources/*/manifest.json' },
  { './*': './resources/*' },
])('validates icons of independent exported manifests: %j', (exports) => {
  manifest({ exports, files: ['resources'] })
  const document = './*' in exports ? 'resources/search/package.json' : 'resources/search/manifest.json'
  json(document, { icon: './icon.webp' })
  file('resources/search/icon.webp', 'webp')
  expect(packageMetaProblems(root)).toEqual([])
  json(document, { icon: './missing.png' })
  expect(packageMetaProblems(root).join('\n')).toContain('missing.png')
})

it('requires publication of both an exported icon manifest and its image', () => {
  manifest({ exports: { './search/package.json': './resources/search.json' }, files: ['resources/icon.svg'] })
  json('resources/search.json', { icon: './icon.svg' })
  file('resources/icon.svg', '<svg/>')
  expect(packageMetaProblems(root).join('\n')).toContain('files must include resources/search.json')
})

it('ignores icon-like fields in unrelated source JSON', () => {
  manifest()
  json('data.json', { icon: false })
  expect(packageMetaProblems(root)).toEqual([])
})

it('excludes tests, installed dependencies, and build output from metadata discovery', () => {
  manifest({ exports: { '.': './lib/index.js' }, files: ['lib'] })
  json('tests/fixtures/locale/en.json', { meta: { title: false } })
  json('node_modules/dependency/locale/en.json', { meta: { title: false } })
  file('lib/locale/en.json', '{')
  expect(packageMetaProblems(root)).toEqual([])
})

it('ignores unrelated locale content without requiring metadata exports', () => {
  manifest({ exports: { '.': './lib/index.js' }, files: ['lib'] })
  json('locale/zh.json', { buttons: { save: '保存' }, enabled: true, other: null })
  expect(packageMetaProblems(root)).toEqual([])
})

it('ignores ordinary JSON metadata outside locale directories and resource exports', () => {
  manifest({ exports: { '.': './lib/index.js', './data.json': './data.json' } })
  json('data.json', { meta: { title: false, schemaVersion: 1 } })
  json('resources/search/en.json', { meta: { description: 'Business data' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('accepts direct root metadata and per-field English fallback without built entries', () => {
  manifest()
  json('locale/en.json', { meta: { title: 'Plugin', description: '%literal%' }, buttons: { save: 'Save' } })
  json('locale/zh.json', { meta: { title: '插件' }, nested: [1, null] })
  json('locale/pt-BR.json', { meta: { description: 'Descrição' } })
  file('locale/README.txt', 'Not a JSON resource.')
  expect(packageMetaProblems(root)).toEqual([])
  expect(existsSync(join(dir, 'lib'))).toBe(false)
})

it.each(['en', 'zh'])('rejects %s metadata resolved into build output without reading that JSON', (language) => {
  manifest({
    exports: {
      './locale/*.json': './locale/*.json',
      [`./locale/${language}.json`]: `./lib/locale/${language}.json`,
    },
  })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  json('locale/zh.json', { meta: { title: '插件' } })
  file(`lib/locale/${language}.json`, '{')
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain(`${language}.json`)
  expect(problems).toContain('source JSON')
  expect(problems).not.toContain('Plugin metadata for')
})

it('does not read built locale JSON while checking a source icon declaration', () => {
  manifest({
    icon: './icon.svg', files: ['icon.svg'],
    exports: { './package.json': './package.json', './locale/en.json': './lib/locale/en.json' },
  })
  file('icon.svg', '<svg/>')
  file('lib/locale/en.json', '{')
  json('locale/en.json', { meta: { title: 'Plugin' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('exports must expose locale/en.json')
  expect(problems).not.toContain('Plugin metadata for')
})

it.each(['lib', 'tests'])('rejects an icon declaration when its only locale is excluded source: %s', (directory) => {
  manifest({
    icon: './missing.svg', files: ['lib'],
    exports: { './package.json': './package.json', './locale/en.json': `./${directory}/locale/en.json` },
  })
  file(`${directory}/locale/en.json`, '{}')
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('@test/plugin: icon metadata requires locale resources to resolve to source JSON')
  expect(problems).not.toContain('Plugin metadata for')
})

it('reads static metadata without evaluating the plugin entry', () => {
  manifest({ exports: { '.': './entry.js', './locale/*.json': './locale/*.json' } })
  file('entry.js', "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./executed', import.meta.url), 'yes'); throw new Error('plugin entry executed')")
  json('locale/en.json', { meta: { title: 'Plugin' } })
  expect(packageMetaProblems(root)).toEqual([])
  expect(existsSync(join(dir, 'executed'))).toBe(false)
})

it('accepts metadata from an unscoped package self-reference', () => {
  manifest({ name: 'plugin' })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('validates root and multiple exported plugins independently', () => {
  manifest({
    exports: {
      '.': './lib/index.js',
      './search': './lib/search.js',
      './write': './lib/write.js',
      './locale/*.json': './locale/root/*.json',
      './search/locale/*.json': './locale/search/*.json',
      './write/locale/*.json': './locale/write/*.json',
    },
  })
  json('locale/root/en.json', { meta: { title: 'Bundle' } })
  json('locale/search/en.json', { meta: { title: 'Search' } })
  json('locale/search/zh.json', { meta: { title: '搜索' } })
  json('locale/write/en.json', { meta: { description: 'Write files' } })
  json('locale/write/zh.json', { meta: { description: '写入文件' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('accepts missing English fields in independently exported plugin metadata', () => {
  manifest({
    exports: {
      '.': './lib/index.js',
      './search': './lib/search.js',
      './locale/*.json': './locale/root/*.json',
      './search/locale/*.json': './locale/search/*.json',
    },
  })
  json('locale/root/en.json', { meta: { description: 'Bundle description' } })
  json('locale/search/en.json', { meta: { title: 'Search' } })
  json('locale/search/zh.json', { meta: { description: '搜索文件' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it.each([
  { '.': './lib/index.js' },
  { '.': './lib/index.js', './locale/*.json': null },
  { '.': './lib/index.js', './locale/*.json': { require: './locale/*.json' } },
  { '.': './lib/index.js', './locale/*.json': './locale/*.json', './locale/en.json': null },
])('rejects a locale file that package exports do not expose: %j', (exports) => {
  manifest({ exports: { ...exports, './package.json': './package.json' } })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('locale/en.json')
  expect(problems).toContain('exports')
})

it('requires exports for every translated resource', () => {
  manifest({ exports: { '.': './lib/index.js', './locale/en.json': './locale/en.json' } })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  json('locale/zh.json', { meta: { title: '插件' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('locale/zh.json')
  expect(problems).toContain('exports')
})

it.each(['locale/search', 'search/locale'])('discovers child metadata without its resource export: %s', (directory) => {
  manifest({ exports: { './search': './lib/search.js' }, files: [directory] })
  json(`${directory}/en.json`, { meta: { title: 'Search' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain(`${directory}/en.json`)
  expect(problems).toContain('exports')
})

it('rejects an inaccessible resource declared outside a locale directory', () => {
  manifest({
    exports: { './search/locale/*.json': { require: './resources/search/*.json' } },
    files: ['resources/search'],
  })
  json('resources/search/en.json', { meta: { title: 'Search' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('resources/search/en.json')
  expect(problems).toContain('exports')
})

it.each([
  './resources/search/*.json',
  { types: './missing/*.json', import: './resources/search/*.json', require: './missing/*.json' },
  { node: { import: './resources/search/*.json' }, default: './missing/*.json' },
  ['./resources/search/*.json'],
])('accepts resource exports to an independent physical directory: %j', (target) => {
  manifest({
    exports: { './search': './lib/search.js', './search/locale/*.json': target },
    files: ['resources/search'],
  })
  json('resources/search/en.json', { meta: { title: 'Search' } })
  json('resources/search/zh.json', { meta: { title: '搜索' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('accepts individually exported resources in an independent physical directory', () => {
  manifest({
    exports: {
      './search': './lib/search.js',
      './search/locale/en.json': './resources/search/en.json',
      './search/locale/zh.json': './resources/search/zh.json',
    },
    files: ['resources'],
  })
  json('resources/search/en.json', { meta: { title: 'Search' } })
  json('resources/search/zh.json', { meta: { title: '搜索' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('ignores metadata in an unselected exports condition', () => {
  manifest({
    exports: { './locale/*.json': { import: './esm/*.json', require: './cjs/*.json' } },
    files: ['esm'],
  })
  json('esm/en.json', { meta: { title: 'ESM plugin' } })
  json('cjs/en.json', { meta: { title: false } })
  expect(packageMetaProblems(root)).toEqual([])
})

it.each([
  { default: './locale/*.json', import: './missing/*.json' },
  [null, './locale/*.json'],
  ['../invalid/*.json', './locale/*.json'],
])('uses Node condition order and export-array fallback: %j', (target) => {
  manifest({ exports: { './locale/*.json': target } })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('does not fall through a valid exports target just because its file is missing', () => {
  manifest({ exports: { './locale/*.json': ['./missing/*.json', './locale/*.json'] } })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  expect(packageMetaProblems(root).join('\n')).toContain('locale/en.json')
})

it('discovers root and child locale resources through a general export wildcard', () => {
  manifest({ exports: { './*': './resources/*' }, files: ['resources'] })
  json('resources/locale/en.json', { meta: { title: 'Bundle' } })
  json('resources/search/locale/en.json', { meta: { title: 'Search' } })
  json('resources/review/locale/en.json', { meta: { title: 'Review' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('rejects an exact resource exclusion under a general export wildcard', () => {
  manifest({ exports: { './*': './resources/*', './search/locale/en.json': null }, files: ['resources'] })
  json('resources/locale/en.json', { meta: { title: 'Bundle' } })
  json('resources/search/locale/en.json', { meta: { title: 'Search' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('search/locale/en.json')
  expect(problems).toContain('exports')
})

it('discovers plugin wildcards with repeated target substitutions', () => {
  manifest({ exports: { './*/locale/en.json': './resources/*/copy-*/en.json' }, files: ['resources'] })
  json('resources/search/copy-search/en.json', { meta: { title: 'Search' } })
  json('resources/review/copy-review/en.json', { meta: { title: 'Review' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('rejects files that do not share the repeated export-target substitution', () => {
  manifest({ exports: { './*/locale/en.json': './locale/*/copy-*/en.json' }, files: ['locale'] })
  json('locale/search/copy-other/en.json', { meta: { title: 'Search' } })
  expect(packageMetaProblems(root).join('\n')).toContain('locale/search/copy-other/en.json')
})

it('rejects a missing exported locale target even when a conventional locale file exists', () => {
  manifest({ exports: { '.': './lib/index.js', './locale/*.json': './missing/*.json' } })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  expect(packageMetaProblems(root).join('\n')).toContain('en.json')
})

it('rejects language resources mapped outside the English resource directory', () => {
  manifest({
    exports: {
      '.': './lib/index.js',
      './locale/en.json': './locale/en.json',
      './locale/zh.json': './elsewhere/zh.json',
    },
    files: ['locale', 'elsewhere'],
  })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  json('locale/zh.json', { meta: { title: '插件' } })
  json('elsewhere/zh.json', { meta: { title: '其他' } })
  expect(packageMetaProblems(root).join('\n')).toContain('zh.json')
})

it.each([undefined, ['.'], ['./'], ['locale'], ['locale/'], ['./locale'], ['locale/*.json'], ['locale/**'],
  ['locale/en.json', 'locale/zh.json']])(
  'accepts published locale resources: %j',
  (files) => {
    manifest({ files })
    json('locale/en.json', { meta: { title: 'Plugin' } })
    json('locale/zh.json', { meta: { title: '插件' } })
    expect(packageMetaProblems(root)).toEqual([])
  },
)

it.each([
  [[], 'en'],
  [['lib'], 'en'],
  [['locale/en.json'], 'zh'],
  [['locale', '!locale/en.json'], 'en'],
  [['locale', '!locale/*.json'], 'en'],
  [['locale', '!locale'], 'en'],
] as const)('rejects omitted or excluded publication files: %j', (files, language) => {
  manifest({ files })
  json('locale/en.json', { meta: { title: 'Plugin' } })
  json('locale/zh.json', { meta: { title: '插件' } })
  expect(packageMetaProblems(root).join('\n')).toContain(`files must include locale/${language}.json`)
})

it.each([{ files: ['locale'] }, { files: ['resources', '!resources/search/zh.json'] }])(
  'checks publication paths after resolving resource exports: %j',
  ({ files }) => {
    manifest({
      exports: { './search': './lib/search.js', './search/locale/*.json': './resources/search/*.json' },
      files,
    })
    json('resources/search/en.json', { meta: { title: 'Search' } })
    json('resources/search/zh.json', { meta: { title: '搜索' } })
    expect(packageMetaProblems(root).join('\n')).toContain('files must include resources/search/')
  },
)

it.each(['locale', 'resources/search'])('rejects translated metadata without an English resource: %s', (directory) => {
  manifest({
    exports: { '.': './lib/index.js', './package.json': './package.json', './locale/*.json': `./${directory}/*.json` },
    files: [directory],
  })
  json(`${directory}/zh.json`, { meta: { title: '插件' } })
  expect(packageMetaProblems(root).join('\n')).toContain('en.json')
})

it.each([
  { field: 'title', packageInfo: true },
  { field: 'description', packageInfo: true },
  { field: 'title', packageInfo: false },
  { field: 'description', packageInfo: false },
])('accepts a missing English $field with package metadata $packageInfo', ({ field, packageInfo }) => {
  manifest({
    exports: {
      '.': './lib/index.js',
      './locale/*.json': './locale/*.json',
      ...packageInfo ? { './package.json': './package.json' } : {},
    },
  })
  json('locale/en.json', { meta: {} })
  json('locale/zh.json', { meta: { [field]: '译文' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it.each([null, [], false, 1, 'text'])('rejects malformed meta: %j', (meta) => {
  manifest()
  json('locale/en.json', { meta })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('en.json')
  expect(problems).toContain('meta')
})

it.each([null, [], false, 1, 'text'])('rejects a non-object English locale document: %j', (contents) => {
  manifest()
  json('locale/en.json', contents)
  expect(packageMetaProblems(root).join('\n')).toContain('en.json')
})

it.each([null, false, 1, {}, [], '', '  '])('rejects a malformed display field: %j', (value) => {
  manifest()
  json('locale/en.json', { meta: { title: 'Plugin', description: 'About it' } })
  json('locale/zh.json', { meta: { title: value } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('zh.json')
  expect(problems).toContain('title')
})

it.each(['en', 'zh'])('rejects malformed JSON in %s.json', (language) => {
  manifest()
  json('locale/en.json', { meta: { title: 'Plugin' } })
  file(`locale/${language}.json`, '{')
  expect(packageMetaProblems(root).join('\n')).toContain(`${language}.json`)
})

it('rejects invalid language filenames', () => {
  manifest()
  json('locale/en.json', { meta: { title: 'Plugin' } })
  json('locale/not_a_language.json', { meta: { title: 'Other' } })
  expect(packageMetaProblems(root).join('\n')).toContain('not_a_language.json')
})

it('rejects case-equivalent language files when the filesystem can hold both', (context) => {
  manifest()
  json('locale/en.json', { meta: { title: 'Plugin' } })
  json('locale/EN.json', { meta: { title: 'Other' } })
  if (readdirSync(join(dir, 'locale')).length !== 2) context.skip()
  expect(packageMetaProblems(root).join('\n')).toContain('duplicates locale en')
})

it('accepts locale files without metadata alongside an English introduction', () => {
  manifest()
  json('locale/en.json', { meta: { title: 'Plugin' } })
  json('locale/zh.json', { buttons: { save: '保存' }, other: null })
  expect(packageMetaProblems(root)).toEqual([])
})

it('reports metadata failures from more than one workspace package', () => {
  manifest()
  json('locale/en.json', { meta: { title: false } })
  dir = join(root, 'packages', 'another', 'second')
  manifest({ name: '@test/second' })
  json('locale/en.json', { meta: { title: 'Second' } })
  json('locale/zh.json', { meta: { description: '' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('@test/plugin')
  expect(problems).toContain('@test/second')
})
