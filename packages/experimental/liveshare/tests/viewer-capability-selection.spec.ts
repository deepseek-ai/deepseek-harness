/**
 * Reading the owner's submitted plugin endpoint selection against the live offers: what is accepted,
 * what each refusal names, and how an empty or partly empty submission is stored.
 */
import { describe, expect, it } from 'vitest'
import { readViewerCapabilitySelection } from '../src/host/viewer-capability-selection.ts'
import type { ViewerCapabilityGroup } from '../src/host/viewer-declarations.ts'

const READABLE = 'mekGit/getGraph'
const SECOND_READABLE = 'mekGit/listBranches'
const WRITABLE = 'mekGit/commit'
const OTHER_READABLE = 'mekSearch/query'

/** The live offers every case is decided against: one plugin offering both kinds, one reading only. */
const OFFERED: readonly ViewerCapabilityGroup[] = [
  { plugin: 'mekGit', readable: [SECOND_READABLE, READABLE], writable: [WRITABLE] },
  { plugin: 'mekSearch', readable: [OTHER_READABLE], writable: [] },
]

describe('owner endpoint selection against the live offers', () => {
  it('accepts the endpoints a plugin currently offers, grouped in offer order', () => {
    expect(readViewerCapabilitySelection(OFFERED, [
      { plugin: 'mekSearch', readable: [OTHER_READABLE], writable: [] },
      { plugin: 'mekGit', readable: [SECOND_READABLE, READABLE], writable: [WRITABLE] },
    ])).toEqual({
      ok: true,
      selection: [
        { plugin: 'mekGit', readable: [READABLE, SECOND_READABLE], writable: [WRITABLE] },
        { plugin: 'mekSearch', readable: [OTHER_READABLE], writable: [] },
      ],
    })
  })

  it('stores no selection for an empty submission, which is the share record omitted', () => {
    expect(readViewerCapabilitySelection(OFFERED, [])).toEqual({ ok: true, selection: undefined })
  })

  it('stores no selection for groups that name nothing, and drops those groups from a mixed one', () => {
    expect(readViewerCapabilitySelection(OFFERED, [
      { plugin: 'mekGit', readable: [], writable: [] },
      { plugin: 'mekSearch', readable: [], writable: [] },
    ])).toEqual({ ok: true, selection: undefined })
    expect(readViewerCapabilitySelection(OFFERED, [
      { plugin: 'mekGit', readable: [], writable: [] },
      { plugin: 'mekSearch', readable: [OTHER_READABLE], writable: [] },
    ])).toEqual({ ok: true, selection: [{ plugin: 'mekSearch', readable: [OTHER_READABLE], writable: [] }] })
  })

  it('merges a plugin submitted more than once and keeps each endpoint once', () => {
    expect(readViewerCapabilitySelection(OFFERED, [
      { plugin: 'mekGit', readable: [READABLE], writable: [] },
      { plugin: 'mekGit', readable: [READABLE, SECOND_READABLE], writable: [WRITABLE] },
    ])).toEqual({
      ok: true,
      selection: [{ plugin: 'mekGit', readable: [READABLE, SECOND_READABLE], writable: [WRITABLE] }],
    })
  })

  it('refuses a plugin the live offers do not name, naming it', () => {
    expect(readViewerCapabilitySelection(OFFERED, [{ plugin: 'ghost', readable: [], writable: [] }]))
      .toEqual({ ok: false, refusal: { code: 'unknown-plugin', plugin: 'ghost' } })
  })

  it('refuses an endpoint the plugin does not offer, naming the plugin, kind, and endpoint', () => {
    expect(readViewerCapabilitySelection(OFFERED, [{ plugin: 'mekGit', readable: ['mekGit/unknown'], writable: [] }]))
      .toEqual({ ok: false, refusal: { code: 'endpoint-not-offered', plugin: 'mekGit', kind: 'readable', endpoint: 'mekGit/unknown' } })
    expect(readViewerCapabilitySelection(OFFERED, [{ plugin: 'mekGit', readable: [], writable: [SECOND_READABLE] }]))
      .toEqual({ ok: false, refusal: { code: 'endpoint-not-offered', plugin: 'mekGit', kind: 'writable', endpoint: SECOND_READABLE } })
  })

  it('keeps the kinds apart: an endpoint offered as writable is not selectable as readable', () => {
    expect(readViewerCapabilitySelection(OFFERED, [{ plugin: 'mekGit', readable: [WRITABLE], writable: [] }]))
      .toEqual({ ok: false, refusal: { code: 'endpoint-not-offered', plugin: 'mekGit', kind: 'readable', endpoint: WRITABLE } })
  })

  it('refuses an endpoint another plugin offers under the same name', () => {
    expect(readViewerCapabilitySelection(OFFERED, [{ plugin: 'mekGit', readable: [OTHER_READABLE], writable: [] }]))
      .toEqual({ ok: false, refusal: { code: 'endpoint-not-offered', plugin: 'mekGit', kind: 'readable', endpoint: OTHER_READABLE } })
  })

  it.each([
    ['a value that is not an array', 'mekGit'],
    ['an entry that is not an object', ['mekGit']],
    ['a missing plugin name', [{ readable: [], writable: [] }]],
    ['an empty plugin name', [{ plugin: '', readable: [], writable: [] }]],
    ['a non-string plugin name', [{ plugin: 7, readable: [], writable: [] }]],
    ['a missing readable list', [{ plugin: 'mekGit', writable: [] }]],
    ['a readable list that is not an array', [{ plugin: 'mekGit', readable: READABLE, writable: [] }]],
    ['a writable list that is not an array', [{ plugin: 'mekGit', readable: [], writable: WRITABLE }]],
    ['a non-string endpoint', [{ plugin: 'mekGit', readable: [7], writable: [] }]],
    ['an empty endpoint name', [{ plugin: 'mekGit', readable: [''], writable: [] }]],
  ])('refuses %s', (_label, input) => {
    expect(readViewerCapabilitySelection(OFFERED, input)).toEqual({ ok: false, refusal: { code: 'invalid-capabilities' } })
  })
})
