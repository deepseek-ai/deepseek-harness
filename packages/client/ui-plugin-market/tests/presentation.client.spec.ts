import { describe, expect, it } from 'vitest'
import type { MarketListingEntry, MarketListingVersion } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { declaredQuery, displayDeclarations, indexLabel, INITIAL_QUERY, presentedVersion, sourceFacts, withText } from '../src/client/presentation.ts'

const resolveText = (text: LocalizedText): string => typeof text === 'string' ? text : text.zh ?? text.en

function release(version: string, fields: Partial<MarketListingVersion> = {}): MarketListingVersion {
  return { version, publishTimestamp: 0, source: { type: 'npm' }, engines: {}, install: { spec: `x@${version}` }, compatibility: { compatible: true }, ...fields }
}

function entry(name: string, fields: Partial<MarketListingEntry> = {}, metadata: Partial<MarketListingEntry['metadata']> = {}): MarketListingEntry {
  return {
    name, versions: [release('1.0.0')], defaultVersion: '1.0.0', installation: { status: 'not-installed' },
    ...fields, metadata: { keywords: [], labels: [], sortKeys: {}, ...metadata },
  }
}

describe('displayDeclarations', () => {
  it('orders by localized title, then by id', () => {
    expect(displayDeclarations({
      b: { title: 'Beta' }, a: { title: { en: 'Alpha', zh: 'Beta' } }, c: { title: 'Alpha' },
    }, resolveText, 'en').map(({ id, title }) => ({ id, title }))).toEqual([{ id: 'c', title: 'Alpha' }, { id: 'a', title: 'Beta' }, { id: 'b', title: 'Beta' }])
    expect(displayDeclarations({ z: { title: 'X' }, x: { title: 'X' }, y: { title: 'X' } }, resolveText, 'en').map(item => item.id)).toEqual(['x', 'y', 'z'])
  })
})

describe('withText', () => {
  it('orders by relevance while there are words, and returns to index order when the text is cleared', () => {
    const typed = withText(INITIAL_QUERY, 'lint')
    expect(typed).toEqual({ ...INITIAL_QUERY, text: 'lint', sort: { kind: 'relevance' } })
    expect(withText(typed, ' ')).toEqual({ ...INITIAL_QUERY, text: ' ' })
    const published = { ...INITIAL_QUERY, sort: { kind: 'published', direction: 'desc' } } as const
    expect(withText(published, 'lint').sort).toBe(published.sort)
    expect(withText({ ...published, text: 'lint' }, '').sort).toBe(published.sort)
    // An order chosen while text is present stays as the text changes.
    const chosen = { ...typed, sort: { kind: 'index' } } as const
    expect(withText(chosen, 'lint rules').sort).toBe(chosen.sort)
  })
})

describe('declaredQuery', () => {
  const metadata = { categories: { tools: { title: 'Tools' } }, labels: { ui: { title: 'UI' } }, sortKeys: { downloads: { title: 'Downloads', order: 'desc' as const } } }
  it('keeps a declared query as is, and drops undeclared ids', () => {
    const declared = { text: 'x', category: 'tools', labels: ['ui'], sort: { kind: 'key', id: 'downloads', direction: 'asc' } } as const
    expect(declaredQuery(declared, metadata)).toBe(declared)
    expect(declaredQuery(INITIAL_QUERY, metadata)).toBe(INITIAL_QUERY)
    expect(declaredQuery({ ...declared, category: 'gone', labels: ['ui', 'gone'], sort: { kind: 'key', id: 'gone', direction: 'asc' } }, metadata))
      .toEqual({ text: 'x', category: null, labels: ['ui'], sort: { kind: 'index' } })
    expect(declaredQuery({ ...declared, labels: ['gone'] }, metadata)).toEqual({ ...declared, labels: [] })
  })
})

describe('presentedVersion', () => {
  it('presents the default version, or the highest when none is compatible', () => {
    const versions = [release('2.0.0'), release('1.0.0')]
    expect(presentedVersion(entry('a', { versions, defaultVersion: '1.0.0' })).version).toBe('1.0.0')
    const { defaultVersion: _unused, ...incompatible } = entry('a', { versions })
    expect(presentedVersion(incompatible).version).toBe('2.0.0')
  })
})

describe('sourceFacts', () => {
  it('names the npm package and registry, or the Git repository, commit, and directory', () => {
    const commit = 'abcdef0'.padEnd(40, '1')
    expect(sourceFacts('dsh-a', release('1.0.0'))).toEqual([{ kind: 'package', value: 'dsh-a@1.0.0' }])
    const registry = release('1.0.0', { source: { type: 'npm', registry: 'https://registry.example:8443/npm/' } })
    expect(sourceFacts('dsh-a', registry)).toEqual([{ kind: 'package', value: 'dsh-a@1.0.0' }, { kind: 'registry', value: 'https://registry.example:8443/npm/' }])
    const git = release('1.0.0', { source: { type: 'git', url: 'https://github.com/o/r', commit } })
    expect(sourceFacts('dsh-a', git)).toEqual([{ kind: 'repository', value: 'https://github.com/o/r' }, { kind: 'commit', value: commit }])
    expect(sourceFacts('dsh-a', release('1.0.0', { source: { type: 'git', url: 'https://github.com/o/r', commit, path: 'packages/a' } })).at(-1))
      .toEqual({ kind: 'directory', value: 'packages/a' })
  })
})

describe('indexLabel', () => {
  it('uses the market title, else the host, else the URL as written', () => {
    expect(indexLabel({ url: 'https://a.example/i.json', title: { en: 'A', zh: '甲' } }, resolveText)).toBe('甲')
    expect(indexLabel({ url: 'https://a.example/i.json' }, resolveText)).toBe('a.example')
    expect(indexLabel({ url: 'https://[' }, resolveText)).toBe('https://[')
  })
})
