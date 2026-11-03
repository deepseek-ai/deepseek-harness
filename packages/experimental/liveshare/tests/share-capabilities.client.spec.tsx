/** The share dialog's per-plugin endpoint control: three modes and the explicit subset they store. */
import { describe, expect, it } from 'vitest'
import {
  endpointSelected,
  pluginDisplayName,
  pluginExposure,
  policyEndpoints,
  sameKeys,
  selectionForOffered,
  selectionKeys,
  setEndpointSelected,
  setPluginExposure,
} from '../src/client/ShareCapabilitiesPicker.tsx'
import type { OfferedPlugin, ViewerPluginPolicy } from '../src/client/share-types.ts'

const A = 'mekGit/getGraph'
const B = 'mekGit/graphMeta'
const OFFERED: readonly OfferedPlugin[] = [
  { plugin: 'mekGit', endpoints: [A, B] },
  { plugin: 'job', endpoints: ['job/list'] },
]

describe('plugin names', () => {
  const group: OfferedPlugin = {
    plugin: 'forgePanel',
    package: '@deepseek-ai/dsh-experimental-client-ui-forge',
    titles: { zh: '变更请求面板', en: 'Change request panel' },
    endpoints: ['forgePanel/follow'],
  }

  it('prefers the active language, then English, then the package segment', () => {
    expect(pluginDisplayName(group, 'zh')).toBe('变更请求面板')
    expect(pluginDisplayName(group, 'fr')).toBe('Change request panel')
    expect(pluginDisplayName({
      plugin: 'officeToPdf',
      package: '@deepseek-ai/dsh-office-to-pdf',
      titles: { en: 'office-to-pdf' },
      endpoints: ['officeToPdf/render'],
    }, 'zh')).toBe('Office to pdf')
    expect(pluginDisplayName({ plugin: 'forgePanel', endpoints: [] }, 'en')).toBe('Forge panel')
  })

  it('keeps a package name with nothing to space out as the label', () => {
    expect(pluginDisplayName({ plugin: 'job', package: '---', endpoints: [] }, 'en')).toBe('---')
  })
})

describe('plugin exposure', () => {
  it('reads an absent or none policy as closed and a full policy as all', () => {
    expect(pluginExposure([], 'mekGit')).toBe('none')
    expect(pluginExposure([{ plugin: 'mekGit', mode: 'none' }], 'mekGit')).toBe('none')
    expect(pluginExposure([{ plugin: 'mekGit', mode: 'all' }], 'mekGit')).toBe('all')
    expect(pluginExposure([{ plugin: 'mekGit', mode: 'selected', endpoints: [A] }], 'mekGit')).toBe('partial')
  })

  it('switches a plugin between the three modes', () => {
    expect(setPluginExposure(OFFERED, [], 'mekGit', 'none')).toEqual([])
    expect(setPluginExposure(OFFERED, [{ plugin: 'mekGit', mode: 'all' }], 'mekGit', 'none')).toEqual([])
    expect(setPluginExposure(OFFERED, [], 'mekGit', 'all'))
      .toEqual([{ plugin: 'mekGit', mode: 'all' }])
    expect(setPluginExposure(OFFERED, [], 'mekGit', 'partial'))
      .toEqual([{ plugin: 'mekGit', mode: 'selected', endpoints: [] }])
    expect(setPluginExposure(OFFERED, [{ plugin: 'mekGit', mode: 'all' }], 'mekGit', 'partial'))
      .toEqual([{ plugin: 'mekGit', mode: 'selected', endpoints: [A, B] }])
  })

  it('exposes nothing for a plugin the host no longer offers', () => {
    expect(policyEndpoints(OFFERED, { plugin: 'removed', mode: 'all' })).toEqual([])
  })

  it('exposes nothing for a selected policy that names no endpoints', () => {
    expect(policyEndpoints(OFFERED, { plugin: 'mekGit', mode: 'selected' })).toEqual([])
  })

  it('selects and clears one endpoint inside a partial policy', () => {
    const one = setEndpointSelected(OFFERED, [], 'mekGit', A, true)
    expect(one).toEqual([{ plugin: 'mekGit', mode: 'selected', endpoints: [A] }])
    expect(policyEndpoints(OFFERED, { plugin: 'mekGit', mode: 'none' })).toEqual([])
    const both = setEndpointSelected(OFFERED, one, 'mekGit', B, true)
    expect(both).toEqual([{ plugin: 'mekGit', mode: 'selected', endpoints: [A, B] }])
    expect(setEndpointSelected(OFFERED, both, 'mekGit', A, false))
      .toEqual([{ plugin: 'mekGit', mode: 'selected', endpoints: [B] }])
    expect(endpointSelected(OFFERED, both, 'mekGit', A)).toBe(true)
    expect(endpointSelected(OFFERED, [], 'mekGit', A)).toBe(false)
    expect(setEndpointSelected(OFFERED, [], 'absent', A, true)).toEqual([])
  })
})

describe('saving and comparing selections', () => {
  it('narrows to the current catalog and drops closed plugins', () => {
    const policies: readonly ViewerPluginPolicy[] = [
      { plugin: 'mekGit', mode: 'all' },
      { plugin: 'job', mode: 'selected', endpoints: ['job/list'] },
      { plugin: 'gone', mode: 'all' },
    ]
    expect(selectionForOffered(OFFERED, policies)).toEqual([
      { plugin: 'mekGit', mode: 'all' },
      { plugin: 'job', mode: 'selected', endpoints: ['job/list'] },
    ])
    expect(selectionForOffered(OFFERED, [{ plugin: 'mekGit', mode: 'selected', endpoints: ['mekGit/gone'] }]))
      .toEqual([])
    expect(selectionForOffered(OFFERED, [{ plugin: 'mekGit', mode: 'none' }])).toEqual([])
    expect(selectionForOffered(OFFERED, [{ plugin: 'mekGit', mode: 'selected' }])).toEqual([])
  })

  it('compares the endpoints a full policy expands to', () => {
    expect(selectionKeys(OFFERED, [{ plugin: 'mekGit', mode: 'all' }]))
      .toEqual([`mekGit\u0000${A}`, `mekGit\u0000${B}`].sort())
    expect(selectionKeys(OFFERED, [{ plugin: 'mekGit', mode: 'selected', endpoints: [B] }]))
      .toEqual([`mekGit\u0000${B}`])
  })

  it('compares sorted endpoint keys exactly', () => {
    expect(sameKeys([A, B], [A, B])).toBe(true)
    expect(sameKeys([A], [A, B])).toBe(false)
    expect(sameKeys([A], [B])).toBe(false)
  })
})
