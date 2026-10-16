import { describe, expect, it } from 'vitest'
import { MarketIndexError, marketInstallTarget, parseMarketIndex } from '../src/index.ts'

const INDEX_URL = 'https://market.example/dsh/index.json'
const COMMIT = '3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4'

function npmVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: '1.2.3', publishTimestamp: 1790476800, source: { type: 'npm' }, ...overrides }
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: '@scope/dsh-foo', versions: [npmVersion()], ...overrides }
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    title: { en: 'Example Market', zh: '示例市场' },
    metadata: {
      categories: { productivity: { title: 'Productivity' } },
      labels: { official: { title: { en: 'Official', zh: '官方' } }, ui: { title: 'UI' } },
      sortKeys: { downloads: { title: 'Downloads', order: 'desc' } },
    },
    plugins: [entry()],
    ...overrides,
  }
}

function rejection(value: unknown): MarketIndexError {
  try {
    parseMarketIndex(value, INDEX_URL)
  } catch (error) {
    if (error instanceof MarketIndexError) return error
    throw error
  }
  throw new Error('index was accepted')
}

function entryRejection(overrides: Record<string, unknown>): string {
  return rejection(document({ plugins: [entry(overrides)] })).message
}

function versionRejection(overrides: Record<string, unknown>): string {
  return entryRejection({ versions: [npmVersion(overrides)] })
}

describe('parseMarketIndex', () => {
  it('accepts a complete index, fills absent groups, resolves relative icons, orders versions, and drops unknown members', () => {
    const index = parseMarketIndex(document({
      description: 'Community bundles',
      extra: true,
      plugins: [
        entry({
          title: { en: 'Foo', 'zh-cn': '甲' },
          description: 'Does foo',
          icon: 'icons/foo.svg',
          author: 'Jane Doe',
          homepage: 'https://github.com/jane/dsh-foo#readme',
          repository: { url: 'https://github.com/jane/dsh-plugins', directory: 'packages/foo', type: 'git' },
          metadata: { category: 'productivity', keywords: ['review'], labels: ['official', 'ui'], sortKeys: { downloads: 12 }, extra: 1 },
          unknown: 'ignored',
          versions: [
            npmVersion({ version: '1.2.3-rc.1', publishTimestamp: 1 }),
            npmVersion({ source: { type: 'npm', registry: 'https://registry.example/', note: 'x' }, engines: { dsh: '>=0.2.0', node: '>=22' } }),
            npmVersion({ version: '1.10.0', publishTimestamp: 2, engines: {} }),
          ],
        }),
        {
          name: 'dsh-bar',
          icon: 'data:image/png;base64,iVBORw==',
          versions: [{
            version: '1.0.0-rc.1+build.5', publishTimestamp: 0,
            source: { type: 'git', url: 'https://gitlab.example/group/sub/repo', commit: COMMIT, path: 'packages/bar' },
          }],
        },
      ],
    }), INDEX_URL)
    expect(index).toEqual({
      format: 1,
      title: { en: 'Example Market', zh: '示例市场' },
      description: 'Community bundles',
      metadata: {
        categories: { productivity: { title: 'Productivity' } },
        labels: { official: { title: { en: 'Official', zh: '官方' } }, ui: { title: 'UI' } },
        sortKeys: { downloads: { title: 'Downloads', order: 'desc' } },
      },
      plugins: [
        {
          name: '@scope/dsh-foo',
          title: { en: 'Foo', 'zh-cn': '甲' },
          description: 'Does foo',
          icon: 'https://market.example/dsh/icons/foo.svg',
          author: 'Jane Doe',
          homepage: 'https://github.com/jane/dsh-foo#readme',
          repository: { url: 'https://github.com/jane/dsh-plugins', directory: 'packages/foo' },
          metadata: { category: 'productivity', keywords: ['review'], labels: ['official', 'ui'], sortKeys: { downloads: 12 } },
          versions: [
            { version: '1.10.0', publishTimestamp: 2, source: { type: 'npm' }, engines: {} },
            { version: '1.2.3', publishTimestamp: 1790476800, source: { type: 'npm', registry: 'https://registry.example/' }, engines: { dsh: '>=0.2.0' } },
            { version: '1.2.3-rc.1', publishTimestamp: 1, source: { type: 'npm' }, engines: {} },
          ],
        },
        {
          name: 'dsh-bar',
          icon: 'data:image/png;base64,iVBORw==',
          metadata: { keywords: [], labels: [], sortKeys: {} },
          versions: [{
            version: '1.0.0-rc.1+build.5', publishTimestamp: 0,
            source: { type: 'git', url: 'https://gitlab.example/group/sub/repo', commit: COMMIT, path: 'packages/bar' },
            engines: {},
          }],
        },
      ],
    })
  })

  it('preserves free-form keywords without declarations, including order, duplicates, and empty strings', () => {
    for (const keywords of [[], ['market-specific', ' npm ', '中文', '', 'market-specific']]) {
      const index = parseMarketIndex({ format: 1, title: 'Keywords', plugins: [entry({ metadata: { keywords } })] }, INDEX_URL)
      expect(index.plugins[0]?.metadata.keywords).toEqual(keywords)
    }
  })

  it('rejects keywords that are not a string array with the offending JSON path', () => {
    for (const keywords of ['review', null, {}]) {
      expect(entryRejection({ metadata: { keywords } })).toBe('$.plugins[0].metadata.keywords must be an array')
    }
    expect(entryRejection({ metadata: { keywords: ['review', 1] } })).toBe('$.plugins[0].metadata.keywords[1] must be a string')
  })

  it('accepts a Git source at the repository root', () => {
    const [plugin] = parseMarketIndex(document({
      plugins: [entry({ versions: [npmVersion({ source: { type: 'git', url: 'https://github.com/o/r.git', commit: COMMIT } })] })],
    }), INDEX_URL).plugins
    expect(plugin?.versions[0]?.source).toEqual({ type: 'git', url: 'https://github.com/o/r.git', commit: COMMIT })
  })

  it('accepts an index without metadata or plugins', () => {
    expect(parseMarketIndex({ format: 1, title: 'Empty', plugins: [] }, INDEX_URL)).toEqual({
      format: 1, title: 'Empty', metadata: { categories: {}, labels: {}, sortKeys: {} }, plugins: [],
    })
  })

  it('accepts absolute https icons, origin-relative http icons, and padded data icons', () => {
    const local = 'http://127.0.0.1:8080/index.json'
    const icons = parseMarketIndex(document({
      plugins: [
        entry({ name: 'a', icon: 'https://cdn.example/a.png' }),
        entry({ name: 'b', icon: '/b.png' }),
        entry({ name: 'c', icon: 'data:image/svg+xml;base64,PHN2Zz4=' }),
      ],
    }), local).plugins.map(plugin => plugin.icon)
    expect(icons).toEqual(['https://cdn.example/a.png', 'http://127.0.0.1:8080/b.png', 'data:image/svg+xml;base64,PHN2Zz4='])
  })

  it('rejects root violations with their JSON path', () => {
    expect(rejection([]).message).toBe('$ must be an object')
    expect(rejection(document({ format: 2 })).path).toBe('$.format')
    expect(rejection(document({ title: '  ' })).message).toBe('$.title must be a string with a non-whitespace character')
    expect(rejection(document({ title: { zh: '市场' } })).message).toBe('$.title must contain en')
    expect(rejection(document({ title: { EN: 'Market' } })).message).toBe('$.title.EN must be keyed by a lowercase language id')
    expect(rejection(document({ plugins: {} })).message).toBe('$.plugins must be an array')
    expect(rejection(document({ metadata: [] })).message).toBe('$.metadata must be an object')
    expect(rejection(document({ metadata: { labels: { '': { title: 'x' } } } })).message).toBe('$.metadata.labels must not declare an empty id')
    expect(rejection(document({ metadata: { categories: { a: 'x' } } })).message).toBe('$.metadata.categories.a must be an object')
    expect(rejection(document({ metadata: { sortKeys: { a: { title: 'A', order: 'up' } } } })).message)
      .toBe('$.metadata.sortKeys.a.order must be "asc" or "desc"')
  })

  it('rejects plugin identity, author, and version list violations', () => {
    expect(entryRejection({ name: 'Bad Name' })).toBe('$.plugins[0].name must be a valid npm package name')
    expect(entryRejection({ name: `a${'b'.repeat(214)}` })).toBe('$.plugins[0].name must be a valid npm package name')
    expect(entryRejection({ author: ' ' })).toBe('$.plugins[0].author must be a string with a non-whitespace character')
    expect(entryRejection({ author: { name: 'Jane' } })).toBe('$.plugins[0].author must be a string with a non-whitespace character')
    expect(entryRejection({ homepage: 'javascript:alert(1)' })).toBe('$.plugins[0].homepage must use https: or http:')
    expect(entryRejection({ homepage: 'docs/foo' })).toBe('$.plugins[0].homepage must be an absolute URL')
    expect(entryRejection({ homepage: 3 })).toBe('$.plugins[0].homepage must be a string with a non-whitespace character')
    expect(parseMarketIndex(document({ plugins: [entry({ homepage: 'http://intranet.example/foo' })] }), INDEX_URL).plugins[0]?.homepage).toBe('http://intranet.example/foo')
    expect(parseMarketIndex(document({ plugins: [entry({ repository: { url: 'http://git.intranet/o/r' } })] }), INDEX_URL).plugins[0]?.repository)
      .toEqual({ url: 'http://git.intranet/o/r' })
    expect(entryRejection({ repository: 'https://github.com/o/r' })).toBe('$.plugins[0].repository must be an object')
    expect(entryRejection({ repository: { url: 'git+ssh://git@github.com/o/r.git' } })).toBe('$.plugins[0].repository.url must use https: or http:')
    expect(entryRejection({ repository: { url: 'https://github.com/o/r#main' } })).toBe('$.plugins[0].repository.url must not contain a query or fragment')
    expect(entryRejection({ repository: { url: 'https://github.com/o/r', directory: '../x' } }))
      .toBe('$.plugins[0].repository.directory must be a relative directory of letters, digits, and ._@+- segments without . or ..')
    expect(entryRejection({ versions: [] })).toBe('$.plugins[0].versions must be a non-empty array')
    expect(entryRejection({ versions: npmVersion() })).toBe('$.plugins[0].versions must be a non-empty array')
    expect(entryRejection({ versions: [npmVersion(), npmVersion({ publishTimestamp: 5 })] })).toBe('$.plugins[0].versions[1].version duplicates 1.2.3')
    expect(rejection(document({ plugins: [entry(), entry()] })).message).toBe('$.plugins[1].name duplicates @scope/dsh-foo')
  })

  it('rejects version identity, time, and engine violations', () => {
    expect(entryRejection({ versions: ['1.2.3'] })).toBe('$.plugins[0].versions[0] must be an object')
    expect(versionRejection({ version: 'v1.2.3' })).toBe('$.plugins[0].versions[0].version must be an exact SemVer version')
    expect(versionRejection({ version: '^1.2.3' })).toBe('$.plugins[0].versions[0].version must be an exact SemVer version')
    for (const publishTimestamp of ['1', 1.5, -1, 1e11]) {
      expect(versionRejection({ publishTimestamp })).toBe('$.plugins[0].versions[0].publishTimestamp must be an integer number of Unix seconds in [0, 10^11)')
    }
    expect(versionRejection({ engines: '>=1' })).toBe('$.plugins[0].versions[0].engines must be an object')
    expect(versionRejection({ engines: { dsh: '' } })).toBe('$.plugins[0].versions[0].engines.dsh must be a string with a non-whitespace character')
    expect(versionRejection({ engines: { dsh: 1 } })).toBe('$.plugins[0].versions[0].engines.dsh must be a string with a non-whitespace character')
    expect(versionRejection({ engines: { dsh: 'workspace:*' } })).toBe('$.plugins[0].versions[0].engines.dsh must not be a workspace: range')
    expect(versionRejection({ engines: { dsh: 'broken' } })).toBe('$.plugins[0].versions[0].engines.dsh must be a SemVer range')
  })

  it('rejects malformed sources', () => {
    const at = '$.plugins[0].versions[0].source'
    const npm = (fields: Record<string, unknown>): string => versionRejection({ source: { type: 'npm', ...fields } })
    expect(versionRejection({ source: { type: 'tarball' } })).toBe(`${at}.type must be "npm" or "git"`)
    expect(npm({ registry: 'not a url' })).toBe(`${at}.registry must be an absolute URL`)
    expect(npm({ registry: 'ftp://registry.example/' })).toBe(`${at}.registry must use https: or http:`)
    expect(npm({ registry: 'https://user:pw@registry.example/' })).toBe(`${at}.registry must not contain credentials`)
    expect(npm({ registry: 'https://registry.example/?a=1' })).toBe(`${at}.registry must not contain a query or fragment`)
    expect(npm({ registry: 'https://registry.example/?' })).toBe(`${at}.registry must not contain a query or fragment`)
    const git = (fields: Record<string, unknown>): string => versionRejection({ source: { type: 'git', url: 'https://github.com/o/r', commit: COMMIT, ...fields } })
    expect(git({ commit: COMMIT.toUpperCase() })).toBe(`${at}.commit must be a lowercase 40-hex-digit commit SHA`)
    expect(git({ commit: COMMIT.slice(0, 7) })).toBe(`${at}.commit must be a lowercase 40-hex-digit commit SHA`)
    expect(git({ url: 'http://github.com/o/r' })).toBe(`${at}.url must use https:`)
    expect(git({ url: 'https://GitHub.com/o/r' })).toBe(`${at}.url must be a canonical URL`)
    expect(git({ url: 'https://github.com/o/r#main' })).toBe(`${at}.url must not contain a query or fragment`)
    expect(git({ url: 'https://github.com/o/r#' })).toBe(`${at}.url must not contain a query or fragment`)
    expect(git({ url: 'https://github.com/o/r?' })).toBe(`${at}.url must not contain a query or fragment`)
    expect(git({ url: 'https://github.com/o' })).toBe(`${at}.url must name a repository with at least two path segments`)
    expect(git({ url: 'https://github.com/o/r/' })).toBe(`${at}.url must name a repository with at least two path segments`)
    expect(git({ url: 'https://example.com/o/r.tgz' })).toBe(`${at}.url must name a repository, not a tarball`)
    for (const path of ['../x', 'a/./b', 'a//b', 'a&b', 'a b']) {
      expect(git({ path })).toBe(`${at}.path must be a relative directory of letters, digits, and ._@+- segments without . or ..`)
    }
  })

  it('rejects malformed icons and market values', () => {
    const dataRule = '$.plugins[0].icon must be a base64 SVG, PNG, JPEG, or WebP data URL'
    expect(entryRejection({ icon: 'data:image/gif;base64,R0lG' })).toBe(dataRule)
    expect(entryRejection({ icon: 'data:image/png;base64,abc' })).toBe(dataRule)
    expect(entryRejection({ icon: 'data:image/png;base64,' })).toBe(dataRule)
    const largest = `data:image/png;base64,${'A'.repeat(43691)}=`
    expect(parseMarketIndex(document({ plugins: [entry({ icon: largest })] }), INDEX_URL).plugins[0]?.icon).toBe(largest)
    expect(entryRejection({ icon: `data:image/png;base64,${'A'.repeat(43692)}` })).toBe('$.plugins[0].icon must not exceed 32 KiB of decoded bytes')
    expect(entryRejection({ icon: 'http://cdn.example/a.png' })).toBe('$.plugins[0].icon must resolve to https or the index origin')
    expect(entryRejection({ icon: 'javascript:alert(1)' })).toBe('$.plugins[0].icon must resolve to https or the index origin')
    expect(entryRejection({ icon: 'https://[' })).toBe('$.plugins[0].icon must be a URL reference')
    expect(entryRejection({ metadata: { category: 'missing' } })).toBe('$.plugins[0].metadata.category references undeclared id "missing"')
    expect(entryRejection({ metadata: { labels: 'official' } })).toBe('$.plugins[0].metadata.labels must be an array')
    expect(entryRejection({ metadata: { labels: ['official', 'official'] } })).toBe('$.plugins[0].metadata.labels must not repeat a label')
    expect(entryRejection({ metadata: { labels: ['constructor'] } })).toBe('$.plugins[0].metadata.labels[0] references undeclared id "constructor"')
    expect(entryRejection({ metadata: { sortKeys: { rating: 1 } } })).toBe('$.plugins[0].metadata.sortKeys.rating references undeclared id "rating"')
    expect(entryRejection({ metadata: { sortKeys: { downloads: Number.NaN } } })).toBe('$.plugins[0].metadata.sortKeys.downloads must be a finite number')
  })

  it('refuses a relative index URL with its own error', () => {
    expect(() => parseMarketIndex({}, 'index.json')).toThrow(MarketIndexError)
  })

  it('keeps ids such as __proto__ as ordinary own keys', () => {
    const raw = '{"format":1,"title":"T","metadata":{"labels":{"__proto__":{"title":"Proto"}},"sortKeys":{"__proto__":{"title":"P","order":"asc"}}},'
      + '"plugins":[{"name":"a","versions":[{"version":"1.0.0","publishTimestamp":0,"source":{"type":"npm"}}],'
      + '"metadata":{"labels":["__proto__"],"sortKeys":{"__proto__":3}}}]}'
    const [plugin] = parseMarketIndex(JSON.parse(raw), INDEX_URL).plugins
    expect(plugin?.metadata.labels).toEqual(['__proto__'])
    expect(Object.entries(plugin?.metadata.sortKeys ?? {})).toEqual([['__proto__', 3]])
  })

  it('rejects a file-origin icon resolved against a file index', () => {
    expect(() => parseMarketIndex(document({ plugins: [entry({ icon: 'a.png' })] }), 'file:///srv/index.json'))
      .toThrow('$.plugins[0].icon must resolve to https or the index origin')
  })
})

describe('marketInstallTarget', () => {
  it('pins npm versions to their exact version and registry', () => {
    expect(marketInstallTarget('dsh-foo', { version: '1.2.3', source: { type: 'npm' } })).toEqual({ spec: 'dsh-foo@1.2.3' })
    expect(marketInstallTarget('@s/dsh-foo', { version: '1.2.3', source: { type: 'npm', registry: 'https://r.example/' } }))
      .toEqual({ spec: '@s/dsh-foo@1.2.3', registry: 'https://r.example/' })
  })

  it('pins Git versions to their commit and package directory', () => {
    expect(marketInstallTarget('a', { version: '1.0.0', source: { type: 'git', url: 'https://github.com/o/r', commit: COMMIT } }))
      .toEqual({ spec: `git+https://github.com/o/r.git#${COMMIT}` })
    expect(marketInstallTarget('a', { version: '1.0.0', source: { type: 'git', url: 'https://gitlab.example/g/s/r.git', commit: COMMIT, path: 'packages/a' } }))
      .toEqual({ spec: `git+https://gitlab.example/g/s/r.git#${COMMIT}&path:/packages/a` })
  })
})
