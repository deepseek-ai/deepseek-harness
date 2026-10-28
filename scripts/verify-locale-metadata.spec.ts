/** Metadata coverage rejects missing translations through the same checker used by CI. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { localeMetadataProblems } from './verify-locale-metadata.ts'

import { SHIPPED_LOCALE_IDS } from './shipped-locales.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(ja: unknown = { meta: { title: '名前 {name}', description: '説明' } }): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-locale-meta-'))
  roots.push(root)
  const directory = join(root, 'packages/demo/plugin/locale')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'en.json'), JSON.stringify({ meta: { title: 'Name {name}' } }))
  writeFileSync(join(directory, 'zh.json'), JSON.stringify({ meta: { title: '名称 {name}', description: '描述' } }))
  writeFileSync(join(directory, 'ja.json'), JSON.stringify(ja))
  for (const language of ['es', 'fr', 'de', 'ru', 'pt']) {
    writeFileSync(join(directory, `${language}.json`), JSON.stringify({ meta: { title: 'Name {name}', description: 'Localized description.' } }))
  }
  return root
}

it('accepts Japanese fields from the union of English and Chinese metadata', () => {
  expect(localeMetadataProblems(fixture())).toEqual([])
})

it('rejects missing Japanese files, including newly added packages', () => {
  const root = fixture()
  rmSync(join(root, 'packages/demo/plugin/locale/ja.json'))
  expect(localeMetadataProblems(root).join('\n')).toContain('ja.json')
})

it.each([
  [{ meta: { title: '名前 {name}' } }, 'missing meta.description'],
  [{ meta: { title: '名前 {other}', description: '説明' } }, 'changes placeholders'],
  [{ meta: { title: '', description: '説明' } }, 'expected non-empty text'],
  [{ meta: { title: '名前 {name}', description: '説明', extra: '余分' } }, 'unexpected meta.extra'],
])('rejects incomplete or inconsistent Japanese metadata', (ja, diagnostic) => {
  expect(localeMetadataProblems(fixture(ja)).join('\n')).toContain(diagnostic)
})

it('checks referenced detail documents', () => {
  const root = fixture()
  const directory = join(root, 'packages/demo/plugin/locale')
  const meta = { title: 'Name {name}', detail: 'docs/DETAIL.md' }
  for (const language of SHIPPED_LOCALE_IDS) writeFileSync(join(directory, `${language}.json`), JSON.stringify({ meta }))
  expect(localeMetadataProblems(root).join('\n')).toContain('missing detail resource')
  mkdirSync(join(directory, '../docs'))
  writeFileSync(join(directory, '../docs/DETAIL.md'), '# Detail\n')
  expect(localeMetadataProblems(root)).toEqual([])
})

it('does not mistake package.json in the locale service package for a translation', () => {
  const root = fixture()
  const directory = join(root, 'packages/client/locale')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), '{"name":"locale"}')
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'src/index.ts'), 'export {}')
  expect(localeMetadataProblems(root)).toEqual([])
})

it('rejects an empty discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-locale-empty-'))
  roots.push(root)
  expect(localeMetadataProblems(root)).toEqual(['no package locale metadata found'])
})

it('rejects loadable plugins without any locale directory', () => {
  const root = fixture()
  const directory = join(root, 'packages/demo/new-plugin')
  mkdirSync(join(directory, 'src'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-new-plugin' }))
  writeFileSync(join(directory, 'src/index.ts'), 'export function apply() {}')
  expect(localeMetadataProblems(root).join('\n')).toContain('new-plugin/locale')
})

it('checks nested subpath locale resources and package-relative detail files', () => {
  const root = fixture()
  const directory = join(root, 'packages/demo/plugin/locale/tools')
  mkdirSync(directory)
  for (const language of ['en', 'zh']) writeFileSync(join(directory, `${language}.json`), JSON.stringify({ meta: { title: 'Tools', detail: 'docs/TOOLS.md' } }))
  mkdirSync(join(root, 'packages/demo/plugin/docs'))
  writeFileSync(join(root, 'packages/demo/plugin/docs/TOOLS.md'), '# Tools\n')
  expect(localeMetadataProblems(root).join('\n')).toContain('locale/tools')
  expect(localeMetadataProblems(root).join('\n')).toContain('ja.json')
  writeFileSync(join(directory, 'ja.json'), JSON.stringify({ meta: { title: 'ツール', detail: 'docs/TOOLS.md' } }))
  for (const language of ['es', 'fr', 'de', 'ru', 'pt']) writeFileSync(join(directory, `${language}.json`), JSON.stringify({ meta: { title: 'Tools', detail: 'docs/TOOLS.md' } }))
  expect(localeMetadataProblems(root)).toEqual([])
})

it.each(['../../other/README.md', 'docs\\DETAIL.md', 'docs/DETAIL.txt', '/README.md'])('rejects runtime-invalid detail path %s', (detail) => {
  const root = fixture({ meta: { title: '名前 {name}', description: '説明', detail } })
  expect(localeMetadataProblems(root).join('\n')).toMatch(/must (?:be a relative path|name a Markdown file)/u)
})

it('requires sentence punctuation for English descriptions', () => {
  const root = fixture()
  const file = join(root, 'packages/demo/plugin/locale/en.json')
  writeFileSync(file, JSON.stringify({ meta: { title: 'Name {name}', description: 'Description' } }))
  expect(localeMetadataProblems(root).join('\n')).toContain('sentence punctuation')
  writeFileSync(file, JSON.stringify({ meta: { title: 'Name {name}', description: 'English description.' } }))
  expect(localeMetadataProblems(root)).toEqual([])
})

it('permits missing Chinese resources for loadable plugins', () => {
  const root = fixture({ meta: { title: '名前 {name}' } })
  const directory = join(root, 'packages/demo/plugin')
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'src/index.ts'), 'export function apply() {}')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-demo' }))
  rmSync(join(directory, 'locale/zh.json'))
  for (const language of ['es', 'fr', 'de', 'ru', 'pt']) writeFileSync(join(directory, `locale/${language}.json`), JSON.stringify({ meta: { title: 'Name {name}' } }))
  expect(localeMetadataProblems(root)).toEqual([])
})

it('excludes packages formally classified as test helpers', () => {
  const root = fixture()
  const directory = join(root, 'packages/test-support/llm-replay')
  mkdirSync(join(directory, 'src'), { recursive: true })
  writeFileSync(join(directory, 'src/index.ts'), 'export function apply() {}')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-replay' }))
  expect(localeMetadataProblems(root)).toEqual([])
})

it.each(['es', 'fr', 'de', 'ru', 'pt'])('rejects missing %s metadata', (language) => {
  const root = fixture()
  rmSync(join(root, `packages/demo/plugin/locale/${language}.json`))
  expect(localeMetadataProblems(root).join('\n')).toContain(`${language}.json`)
})

it.each(['es', 'fr', 'de', 'ru', 'pt'])('rejects untranslated Chinese descriptions in %s metadata', (language) => {
  const root = fixture()
  writeFileSync(join(root, 'packages/demo/plugin/locale/en.json'), JSON.stringify({ meta: { title: 'Name {name}', description: 'English description.' } }))
  writeFileSync(join(root, `packages/demo/plugin/locale/${language}.json`), JSON.stringify({ meta: { title: 'Name {name}', description: '描述' } }))
  expect(localeMetadataProblems(root).join('\n')).toContain(`${language}.json: meta.description contains untranslated source text`)
})

it.each(['es', 'fr', 'de', 'ru', 'pt'])('rejects copied English descriptions in %s metadata', (language) => {
  const root = fixture()
  writeFileSync(join(root, 'packages/demo/plugin/locale/en.json'), JSON.stringify({ meta: { title: 'Name {name}', description: 'English description.' } }))
  writeFileSync(join(root, `packages/demo/plugin/locale/${language}.json`), JSON.stringify({ meta: { title: 'Name {name}', description: 'English description.' } }))
  expect(localeMetadataProblems(root).join('\n')).toContain(`${language}.json: meta.description contains untranslated source text`)
})

it.each(['\u200b', '\ufeff', String.raw`\u200b`, String.raw`\ufeff`])('rejects invisible characters in JSON resources', (character) => {
  const root = fixture()
  const file = join(root, 'packages/demo/plugin/locale/es.json')
  writeFileSync(file, readFileSync(file, 'utf8').replace('Localized description.', `Localized${character} description.`))
  expect(localeMetadataProblems(root).join('\n')).toContain('invisible locale character')
})
