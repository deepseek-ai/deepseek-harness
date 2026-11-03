import { describe, expect, it } from 'vitest'
import { bundleTitleMap, bundleTitlesOf, type BundleTitleBundle } from '../src/host/bundle-titles.ts'

describe('bundleTitleMap', () => {
  it('maps a component row to its bundle identity and marks profile bundles as core', () => {
    const bundles: BundleTitleBundle[] = [
      { name: '@deepseek-ai/dsh-base', meta: { title: 'DSH' }, rows: [{ moduleName: '@fixture/base-component' }] },
      { name: '@fixture/forge-bundle', meta: { title: { zh: '变更请求与工作树', en: 'Change requests' } },
        rows: [{ moduleName: '@deepseek-ai/dsh-experimental-client-ui-forge' }] },
    ]
    const titles = bundleTitleMap(bundles)
    expect(titles.get('@fixture/base-component')).toEqual({
      name: '@deepseek-ai/dsh-base',
      core: true,
      titles: { en: 'DSH' },
    })
    expect(titles.get('@deepseek-ai/dsh-experimental-client-ui-forge')).toEqual({
      name: '@fixture/forge-bundle',
      core: false,
      titles: { zh: '变更请求与工作树', en: 'Change requests' },
    })
  })

  it('accepts a literal string title and skips missing or empty titles and rows', () => {
    const titles = bundleTitleMap([
      { name: '@fixture/string-bundle', meta: { title: 'String bundle' }, rows: [{ moduleName: '@fixture/component' }] },
      { name: '@fixture/no-title', rows: [{ moduleName: '@fixture/untitled' }] },
      { name: '@fixture/empty-title', meta: { title: '' }, rows: [{ moduleName: '@fixture/empty' }] },
      { name: '@fixture/empty-row', meta: { title: 'Empty row' }, rows: [{ moduleName: '' }, {}] },
    ])
    expect(titles.get('@fixture/component')).toEqual({
      name: '@fixture/string-bundle',
      core: false,
      titles: { en: 'String bundle' },
    })
    expect(titles.has('@fixture/untitled')).toBe(false)
    expect(titles.has('@fixture/empty')).toBe(false)
  })

  it('skips a bundle without a name', () => {
    expect(bundleTitleMap([{ name: '', rows: [] }])).toEqual(new Map())
  })

  it('keeps only the non-empty string entries of a localized title and drops one left with none', () => {
    const titles = bundleTitleMap([
      { name: '@fixture/mixed-title', meta: { title: { en: 'Mixed', zh: '' } }, rows: [{ moduleName: '@fixture/mixed' }] },
      { name: '@fixture/unusable-title', meta: { title: { zh: 3 } }, rows: [{ moduleName: '@fixture/unusable' }] },
    ])
    expect(titles.get('@fixture/mixed')).toEqual({
      name: '@fixture/mixed-title',
      core: false,
      titles: { en: 'Mixed' },
    })
    expect(titles.has('@fixture/unusable')).toBe(false)
  })

  it('maps a core bundle without a title and skips a bundle that reports no rows', () => {
    const titles = bundleTitleMap([
      { name: '@deepseek-ai/dsh-base', rows: [{ moduleName: '@fixture/base-component' }] },
      { name: '@fixture/rows-less', meta: { title: 'Rows-less' } },
    ])
    expect([...titles]).toEqual([
      ['@fixture/base-component', { name: '@deepseek-ai/dsh-base', core: true }],
    ])
  })

  it('returns no titles when the plugin manager cannot list bundles', async () => {
    const manager = { listBundles: async () => { throw new Error('not mounted') } }
    await expect(bundleTitlesOf(manager)).resolves.toEqual(new Map())
  })
})
