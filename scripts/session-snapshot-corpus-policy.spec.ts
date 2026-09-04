import { describe, expect, it } from 'vitest'
import { assertV2SnapshotCorpusPolicy } from './session-snapshot-corpus-policy.ts'

const completeV0 = {
  key: 'session/v0',
  selectedVersions: [0],
  retained: {
    version: 0,
    coverage: ['multi-hop', 'packed-row', 'retry-failure', 'shipped-profile'],
  },
} as const

describe('v2 recorded-session corpus policy', () => {
  it('accepts a current majority and the complete bounded v0/v1 migration set', () => {
    expect(assertV2SnapshotCorpusPolicy([
      { key: 'session/current', selectedVersions: [2, 2, 2, 2, 2, 2, 2, 2] },
      {
        key: 'session/multi-hop',
        selectedVersions: [0, 0, 0],
        retained: { version: 0, coverage: ['multi-hop', 'shipped-profile'] },
      },
      {
        key: 'session/packed',
        selectedVersions: [0],
        retained: { version: 0, coverage: ['packed-row'] },
      },
      {
        key: 'session/retry',
        selectedVersions: [0],
        retained: { version: 0, coverage: ['retry-failure'] },
      },
      {
        key: 'sdk/adjacent',
        selectedVersions: [1, 1],
        retained: { version: 1, coverage: ['adjacent-migration'] },
      },
    ])).toEqual({ currentRoles: 8, retainedRoles: 7, retainedScenarios: 4 })
  })

  it('requires v0 coverage from v0 fixtures and adjacent coverage from v1 fixtures', () => {
    expect(() => assertV2SnapshotCorpusPolicy([
      { key: 'session/current', selectedVersions: Array<number>(8).fill(2) },
      {
        key: 'sdk/wrong-generation',
        selectedVersions: [1],
        retained: {
          version: 1,
          coverage: ['adjacent-migration'],
        },
      },
    ])).toThrow('v2 Session corpus lacks v0 coverage')
  })

  it('does not let one retained generation claim another edge\'s coverage', () => {
    expect(() => assertV2SnapshotCorpusPolicy([
      { key: 'session/current', selectedVersions: Array<number>(8).fill(2) },
      completeV0,
      {
        key: 'sdk/adjacent',
        selectedVersions: [1],
        retained: { version: 1, coverage: ['adjacent-migration', 'multi-hop'] },
      },
    ])).toThrow('sdk/adjacent: v1 retained coverage must be adjacent-migration')
  })

  it('rejects an undeclared historical role and a retained current generation', () => {
    expect(() => assertV2SnapshotCorpusPolicy([
      { key: 'session/empty', selectedVersions: [] },
    ])).toThrow('session/empty: scenario owns no selected Session role')
    expect(() => assertV2SnapshotCorpusPolicy([
      { key: 'session/old', selectedVersions: [1] },
    ])).toThrow('session/old: selected Session generation v1 does not match expected v2')
    expect(() => assertV2SnapshotCorpusPolicy([
      {
        key: 'session/not-historical',
        selectedVersions: [2],
        retained: { version: 2, coverage: ['adjacent-migration'] },
      },
    ])).toThrow('session/not-historical: v2 corpus may retain only Session format v0 or v1')
  })

  it('requires one direct v1 migration fixture', () => {
    expect(() => assertV2SnapshotCorpusPolicy([
      { key: 'session/current', selectedVersions: Array<number>(8).fill(2) },
      completeV0,
    ])).toThrow('v2 Session corpus lacks v1 coverage: adjacent-migration')
  })

  it('bounds historical roles and requires the current generation to remain the majority', () => {
    const retained = [
      {
        ...completeV0,
        selectedVersions: Array<number>(11).fill(0),
      },
      {
        key: 'sdk/v1',
        selectedVersions: [1],
        retained: { version: 1, coverage: ['adjacent-migration'] },
      },
    ] as const
    expect(() => assertV2SnapshotCorpusPolicy([
      { key: 'session/current', selectedVersions: Array<number>(20).fill(2) },
      ...retained,
    ])).toThrow('v2 Session corpus retains 12 historical roles; maximum is 10')
    expect(() => assertV2SnapshotCorpusPolicy([
      { key: 'session/current', selectedVersions: [2] },
      { ...retained[0], selectedVersions: [0, 0] },
      retained[1],
    ])).toThrow('v2 Session corpus requires a current majority; current=1, retained=3')
  })
})
