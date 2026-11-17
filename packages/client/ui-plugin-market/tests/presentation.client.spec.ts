import { describe, expect, it } from 'vitest'
import type { MarketListingEntry, MarketListingVersion } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import {
  declaredQuery, displayDeclarations, indexLabel, indexMenuItems, INITIAL_QUERY, presentedVersion, sourceFacts, withText,
} from '../src/client/presentation.ts'

const resolveText = (text: LocalizedText): string => typeof text === 'string' ? text : text.zh ?? text.en

function release(version: string, fields: Partial<MarketListingVersion> = {}): MarketListingVersion {
  return { version, publishTimestamp: 0, source: { type: 'npm' }, engines: {}, install: { spec: `x@${version}` }, compatibility: { compatible: true }, update: false, ...fields }
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

describe('indexMenuItems', () => {
  it.each([
    'git+https://github.com/acme/plugins.git?path=market%2Findex.json&ref=main',
    'git+ssh://git@github.com/acme/plugins.git',
  ])('uses the GitHub repository in the toolbar for %s', (url) => {
    const index = { url, title: { en: 'Internal plugins', zh: '内部插件' } }
    expect(indexMenuItems([index], resolveText)).toEqual([{ id: url, label: 'github:acme/plugins' }])
    expect(indexLabel(index, resolveText)).toBe('内部插件')
  })

  it('preserves localized Raw titles and distinguishes matching titles by their Raw locations', () => {
    const main = 'https://raw.githubusercontent.com/acme/plugins/refs/heads/main/index.json'
    const next = 'https://raw.githubusercontent.com/acme/plugins/refs/heads/next/index.json'
    const release = 'https://raw.githubusercontent.com/acme/plugins/refs/heads/release/stable/index.json'
    const title = { en: 'Official plugins', zh: '官方插件' }
    expect(indexMenuItems([{ url: main, title }, { url: next, title }, { url: release }], resolveText)).toEqual([
      { id: main, label: '官方插件 · github:acme/plugins · refs/heads/main/index.json' },
      { id: next, label: '官方插件 · github:acme/plugins · refs/heads/next/index.json' },
      { id: release, label: 'github:acme/plugins' },
    ])
  })

  it('distinguishes same-repository Git indexes by path and ref', () => {
    const root = 'git+https://github.com/acme/plugins.git'
    const customPath = `${root}?path=market%2Findex.json`
    const customRef = `${customPath}&ref=release%2Fstable`
    expect(indexMenuItems([{ url: root }, { url: customPath }, { url: customRef }], resolveText)).toEqual([
      { id: root, label: 'github:acme/plugins · HEAD:index.json' },
      { id: customPath, label: 'github:acme/plugins · HEAD:market/index.json' },
      { id: customRef, label: 'github:acme/plugins · release/stable:market/index.json' },
    ])
  })

  it('distinguishes matching Raw locations without putting URL query strings in labels', () => {
    const raw = 'https://raw.githubusercontent.com/acme/plugins/main/index.json'
    const first = `${raw}?token=one`
    const second = `${raw}?token=two`
    expect(indexMenuItems([{ url: first }, { url: second }], resolveText)).toEqual([
      { id: first, label: 'github:acme/plugins · main/index.json (1)' },
      { id: second, label: 'github:acme/plugins · main/index.json (2)' },
    ])
  })

  it('uses the regular index label when the address does not identify a GitHub index', () => {
    const indexes = [
      { url: 'git+https://git.example/acme/plugins.git', title: 'Internal plugins' },
      { url: 'https://github.com/acme/plugins', title: 'Direct index' },
      { url: 'git+https://github.com/acme', title: 'Invalid Git source' },
      { url: 'git+https://github.com/acme/plugins.git?token=secret' },
      { url: 'https://raw.githubusercontent.com/acme/plugins/main' },
      { url: 'https://[' },
    ]
    expect(indexMenuItems(indexes, resolveText).map(item => item.label)).toEqual([
      'Internal plugins', 'Direct index', 'Invalid Git source', 'github.com', 'raw.githubusercontent.com', 'https://[',
    ])
  })
})
