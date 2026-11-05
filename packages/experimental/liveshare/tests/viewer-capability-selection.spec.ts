import { describe, expect, it } from 'vitest'
import { readViewerPluginPolicies } from '../src/host/viewer-capability-selection.ts'
import type { ShareablePluginCatalog } from '../src/host/viewer-capability-types.ts'

const OFFERED: readonly ShareablePluginCatalog[] = [
  { plugin: 'mekGit', endpoints: ['mekGit/commit', 'mekGit/getGraph', 'mekGit/graphMeta'] },
  { plugin: 'job', endpoints: ['job/follow', 'job/list'] },
]

describe('readViewerPluginPolicies', () => {
  it('reads all, none, and an explicit subset', () => {
    expect(readViewerPluginPolicies(OFFERED, [
      { plugin: 'mekGit', mode: 'all' },
      { plugin: 'job', mode: 'selected', endpoints: ['job/list'] },
    ])).toEqual({
      ok: true,
      selection: [
        { plugin: 'mekGit', mode: 'all' },
        { plugin: 'job', mode: 'selected', endpoints: ['job/list'] },
      ],
    })
  })

  it('treats none and an empty submission as no exposure', () => {
    expect(readViewerPluginPolicies(OFFERED, [{ plugin: 'mekGit', mode: 'none' }]))
      .toEqual({ ok: true, selection: undefined })
    expect(readViewerPluginPolicies(OFFERED, [])).toEqual({ ok: true, selection: undefined })
  })

  it('drops an empty selected subset', () => {
    expect(readViewerPluginPolicies(OFFERED, [
      { plugin: 'mekGit', mode: 'selected', endpoints: [] },
      { plugin: 'job', mode: 'selected', endpoints: ['job/list', 'job/follow'] },
    ])).toEqual({ ok: true, selection: [{ plugin: 'job', mode: 'selected', endpoints: ['job/follow', 'job/list'] }] })
  })

  it('refuses an unknown plugin, an unoffered endpoint, and a malformed mode', () => {
    expect(readViewerPluginPolicies(OFFERED, [{ plugin: 'ghost', mode: 'all' }]))
      .toEqual({ ok: false, refusal: { code: 'unknown-plugin', plugin: 'ghost' } })
    expect(readViewerPluginPolicies(OFFERED, [
      { plugin: 'mekGit', mode: 'selected', endpoints: ['mekGit/unknown'] },
    ])).toEqual({ ok: false, refusal: { code: 'endpoint-not-offered', plugin: 'mekGit', endpoint: 'mekGit/unknown' } })
    expect(readViewerPluginPolicies(OFFERED, [{ plugin: 'mekGit', mode: 'sometimes' }]))
      .toEqual({ ok: false, refusal: { code: 'invalid-capabilities' } })
    expect(readViewerPluginPolicies(OFFERED, null)).toEqual({ ok: false, refusal: { code: 'invalid-capabilities' } })
  })

  it('refuses malformed entries and endpoint lists', () => {
    for (const input of [
      [null],
      [{ plugin: 3, mode: 'all' }],
      [{ plugin: '', mode: 'all' }],
      [{ plugin: 'mekGit', mode: 'selected' }],
      [{ plugin: 'mekGit', mode: 'selected', endpoints: ['mekGit/commit', 3] }],
    ]) {
      expect(readViewerPluginPolicies(OFFERED, input))
        .toEqual({ ok: false, refusal: { code: 'invalid-capabilities' } })
    }
  })
})
