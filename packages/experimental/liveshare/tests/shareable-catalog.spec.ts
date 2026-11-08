import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { onTestFinished } from 'vitest'
import { describe, expect, it } from 'vitest'
import {
  EXCLUDED_SHARE_NAMESPACES,
  packageRoot,
  readTitles,
  shareableViewerCatalog,
  type PluginMetadata,
} from '../src/host/shareable-catalog.ts'

/** A local registry snapshot from one package's <namespace>/<method> names. */
function registryOf(packageName: string, ...names: string[]) {
  return {
    list: () => names.map((name) => {
      const separator = name.indexOf('/')
      return {
        id: `${packageName}#${name}`,
        namespace: name.slice(0, separator),
        method: name.slice(separator + 1),
      }
    }),
  }
}

/** A local registry snapshot whose package this test tree cannot resolve. */
function registry(...names: string[]) {
  return registryOf('@fixture/plugins', ...names)
}

/** Write one temporary tree and remove it after the case. */
function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'liveshare-catalog-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  return root
}

const metadata = (value: PluginMetadata) => () => value

describe('shareableViewerCatalog', () => {
  it('groups every registered method by namespace and carries the package', () => {
    expect(shareableViewerCatalog(registry('forgePanel/follow', 'forgePanel/changeRequestStates', 'mekGit/getGraph'),
      metadata({ package: '@fixture/plugins' })))
      .toEqual([
        {
          plugin: 'forgePanel',
          package: '@fixture/plugins',
          endpoints: ['forgePanel/changeRequestStates', 'forgePanel/follow'],
        },
        { plugin: 'mekGit', package: '@fixture/plugins', endpoints: ['mekGit/getGraph'] },
      ])
  })

  it('reads the plugin package locale titles', () => {
    const groups = shareableViewerCatalog(registryOf(
      '@deepseek-ai/dsh-experimental-client-ui-forge', 'forgePanel/follow',
    ))
    expect(groups[0]).toMatchObject({
      plugin: 'forgePanel',
      package: '@deepseek-ai/dsh-experimental-client-ui-forge',
      titles: { zh: '变更请求面板', en: 'Change request panel' },
    })
  })

  it('omits package and titles when the descriptor id names no package', () => {
    const local = { list: () => [{ id: 'plain', namespace: 'mekGit', method: 'getGraph' }] }
    expect(shareableViewerCatalog(local, metadata({ package: 'ignored' }))).toEqual([
      { plugin: 'mekGit', endpoints: ['mekGit/getGraph'] },
    ])
  })

  it('carries titles from an injected reader and drops an empty package', () => {
    expect(shareableViewerCatalog(registry('mekGit/getGraph'),
      metadata({ package: 'mekGit-pkg', titles: { en: 'Mek Git' } }))).toEqual([
      { plugin: 'mekGit', package: 'mekGit-pkg', titles: { en: 'Mek Git' }, endpoints: ['mekGit/getGraph'] },
    ])
    expect(shareableViewerCatalog(registry('mekGit/getGraph'), metadata({}))).toEqual([
      { plugin: 'mekGit', endpoints: ['mekGit/getGraph'] },
    ])
  })

  it('skips empty namespace and method descriptors', () => {
    const local = {
      list: () => [
        { id: 'x#/method', namespace: '', method: 'method' },
        { id: 'x#ns/', namespace: 'ns', method: '' },
        { id: 'x#ns/ok', namespace: 'ns', method: 'ok' },
      ],
    }
    expect(shareableViewerCatalog(local, metadata({}))).toEqual([
      { plugin: 'ns', endpoints: ['ns/ok'] },
    ])
  })

  it('excludes DSH core services and LiveShare management', () => {
    for (const namespace of ['session', 'workspaceFiles', 'settings', 'credentials', 'terminal', 'pluginManager', 'liveshareShares']) {
      expect(EXCLUDED_SHARE_NAMESPACES.has(namespace)).toBe(true)
    }
    expect(shareableViewerCatalog(registry('session/page', 'settings/mutate', 'mekGit/getGraph'),
      metadata({ package: '@fixture/plugins' }))).toEqual([
      { plugin: 'mekGit', package: '@fixture/plugins', endpoints: ['mekGit/getGraph'] },
    ])
  })

  it('keeps experimental plugin namespaces and has no read/write filter', () => {
    const groups = shareableViewerCatalog(registry(
      'forgePanel/follow', 'cuaAccess/applications', 'dynamicCordisRunner/invoke', 'mekGit/writeThing',
    ), metadata({}))
    expect(groups.map(group => group.plugin)).toEqual(['cuaAccess', 'dynamicCordisRunner', 'forgePanel', 'mekGit'])
    expect(groups.flatMap(group => group.endpoints)).toContain('mekGit/writeThing')
  })

  it('offers nothing when the composition mounts no Typert registry', () => {
    expect(shareableViewerCatalog()).toEqual([])
  })

  it('keeps the package name when the installed package ships no titles', () => {
    expect(shareableViewerCatalog(registryOf('@deepseek-ai/dsh-brand', 'brand/key')).at(0)).toEqual({
      plugin: 'brand',
      package: '@deepseek-ai/dsh-brand',
      endpoints: ['brand/key'],
    })
  })

  it('falls back to no metadata when the package cannot be resolved', () => {
    expect(shareableViewerCatalog(registry('mekGit/getGraph')).at(0)).toEqual({
      plugin: 'mekGit',
      package: '@fixture/plugins',
      endpoints: ['mekGit/getGraph'],
    })
  })

  it('carries each method description from its descriptor', () => {
    const local = {
      list: () => [
        { id: '@fixture/plugins#mekGit/getGraph', namespace: 'mekGit', method: 'getGraph', description: 'Read the graph' },
        { id: '@fixture/plugins#mekGit/reset', namespace: 'mekGit', method: 'reset' },
      ],
    }
    expect(shareableViewerCatalog(local, metadata({ package: '@fixture/plugins' }))).toEqual([{
      plugin: 'mekGit',
      package: '@fixture/plugins',
      endpoints: ['mekGit/getGraph', 'mekGit/reset'],
      descriptions: { 'mekGit/getGraph': 'Read the graph' },
    }])
  })

  it('omits components mounted by a core profile bundle', () => {
    expect(shareableViewerCatalog(registry('webRuntime/info'), () => ({
      package: '@fixture/core',
      bundle: '@deepseek-ai/dsh-web-app',
      core: true,
    }))).toEqual([])
  })

  it('merges component namespaces that belong to one feature bundle', () => {
    const local = {
      list: () => [
        { id: '@fixture/bundle#forgePanel/follow', namespace: 'forgePanel', method: 'follow' },
        { id: '@fixture/bundle#worktree/create', namespace: 'worktree', method: 'create' },
      ],
    }
    const groups = shareableViewerCatalog(local, () => ({
      package: '@fixture/bundle',
      bundle: '@fixture/bundle',
      titles: { zh: '变更请求与工作树' },
    }))
    expect(groups).toEqual([{
      plugin: '@fixture/bundle',
      package: '@fixture/bundle',
      titles: { zh: '变更请求与工作树' },
      endpoints: ['forgePanel/follow', 'worktree/create'],
    }])
  })
})

describe('packageRoot', () => {
  it('finds the manifest beside the package name under a search path', () => {
    const root = fixture({ 'node_modules/@fixture/plugins/package.json': '{"name":"@fixture/plugins"}' })
    expect(packageRoot('@fixture/plugins', [join(root, 'node_modules')]))
      .toBe(join(root, 'node_modules/@fixture/plugins'))
  })

  it('skips a manifest whose name belongs to another package', () => {
    const root = fixture({ 'node_modules/@fixture/plugins/package.json': '{"name":"@other/plugins"}' })
    expect(packageRoot('@fixture/plugins', [join(root, 'node_modules')])).toBeUndefined()
  })

  it('skips an unreadable manifest and keeps searching', () => {
    const root = fixture({ 'node_modules/@fixture/plugins/package.json': '{not json' })
    expect(packageRoot('@fixture/plugins', [join(root, 'node_modules')])).toBeUndefined()
  })

  it('returns undefined when no search path carries the manifest', () => {
    const root = fixture({})
    expect(packageRoot('@fixture/plugins', [join(root, 'node_modules'), join(root, 'other')])).toBeUndefined()
    expect(packageRoot('@fixture/plugins', [])).toBeUndefined()
  })

  it('uses the resolver search paths when none are supplied', () => {
    expect(packageRoot('@deepseek-ai/dsh-experimental-client-ui-forge'))
      .toMatch(/dsh-experimental-client-ui-forge$/u)
    expect(packageRoot('fs')).toBeUndefined()
  })
})

describe('readTitles', () => {
  it('keeps every readable title and skips missing or invalid locale files', () => {
    const root = fixture({
      'locale/en.json': '{"meta":{"title":"Mek Git"}}',
      'locale/zh.json': '{"meta":{"title":"Mek 仓库"}}',
      'locale/ja.json': '{not json',
      'locale/es.json': '{"meta":{"title":42}}',
      'locale/fr.json': '{"meta":{"title":""}}',
    })
    expect(readTitles(root)).toEqual({ en: 'Mek Git', zh: 'Mek 仓库' })
  })

  it('returns undefined when the package ships no title', () => {
    const root = fixture({ 'locale/en.json': '{"meta":{}}' })
    expect(readTitles(root)).toBeUndefined()
  })
})
