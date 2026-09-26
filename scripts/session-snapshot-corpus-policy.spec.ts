import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { assertSnapshotCorpusPolicy } from './session-snapshot-corpus-policy.ts'

const completeV0 = {
  key: 'session/v0',
  selectedVersions: [0],
  retained: {
    version: 0,
    coverage: ['multi-hop', 'packed-row', 'retry-failure', 'shipped-profile'],
  },
} as const

const adjacent = [1, 2].map(version => ({
  key: `sdk/v${version}`,
  selectedVersions: [version],
  retained: { version, coverage: ['adjacent-migration'] as const },
}))
const baseline = { key: 'session/v3', selectedVersions: Array<number>(8).fill(3) }
const current = { key: 'session/current', selectedVersions: Array<number>(8).fill(SESSION_FORMAT_VERSION) }

describe('recorded-session corpus policy', () => {
  it('keeps a V3 majority as migration input without requiring current-generation successors', () => {
    expect(assertSnapshotCorpusPolicy([
      baseline,
      {
        key: 'session/multi-hop',
        selectedVersions: [0, 0, 0],
        retained: { version: 0, coverage: ['multi-hop', 'shipped-profile'] },
      },
      { key: 'session/packed', selectedVersions: [0], retained: { version: 0, coverage: ['packed-row'] } },
      { key: 'session/retry', selectedVersions: [0], retained: { version: 0, coverage: ['retry-failure'] } },
      ...adjacent,
    ])).toEqual({ currentRoles: 0, baselineRoles: 8, retainedRoles: 5 + adjacent.length, retainedScenarios: 3 + adjacent.length })
  })

  it('accepts current-writer owners alongside retained V3 replay input', () => {
    expect(assertSnapshotCorpusPolicy([baseline, current, completeV0, ...adjacent]))
      .toEqual({ currentRoles: 8, baselineRoles: 8, retainedRoles: 3, retainedScenarios: 3 })
  })

  it('rejects refreshing away every direct V3 migration input', () => {
    expect(() => assertSnapshotCorpusPolicy([current, completeV0, ...adjacent]))
      .toThrow('Session corpus lacks v3 coverage: adjacent-migration')
  })

  it('retains retired tools in the current format without claiming migration coverage', () => {
    const retired = {
      key: 'web/retired', selectedVersions: [SESSION_FORMAT_VERSION],
      retained: { version: SESSION_FORMAT_VERSION, coverage: ['retired-tools'] as const },
    }
    expect(assertSnapshotCorpusPolicy([current, baseline, completeV0, ...adjacent, retired]).retainedScenarios)
      .toBe(2 + adjacent.length)
    expect(() => assertSnapshotCorpusPolicy([current, completeV0, retired]))
      .toThrow('coverage: adjacent-migration')
    expect(() => assertSnapshotCorpusPolicy([current, completeV0, ...adjacent, {
      ...retired, selectedVersions: [SESSION_FORMAT_VERSION + 1],
      retained: { ...retired.retained, version: SESSION_FORMAT_VERSION + 1 },
    }])).toThrow('retained Session format must precede')
  })

  it('requires v0 coverage from v0 fixtures', () => {
    expect(() => assertSnapshotCorpusPolicy([baseline, ...adjacent]))
      .toThrow('Session corpus lacks v0 coverage')
  })

  it.each(adjacent)('requires direct coverage from $key', (fixture) => {
    expect(() => assertSnapshotCorpusPolicy([
      baseline, completeV0, ...adjacent.filter(other => other !== fixture),
    ])).toThrow(`Session corpus lacks v${fixture.retained.version} coverage: adjacent-migration`)
  })

  it('does not let one retained generation claim another edge\'s coverage', () => {
    expect(() => assertSnapshotCorpusPolicy([
      baseline,
      completeV0,
      {
        key: 'sdk/adjacent',
        selectedVersions: [1],
        retained: { version: 1, coverage: ['adjacent-migration', 'multi-hop'] },
      },
    ])).toThrow('sdk/adjacent: v1 retained coverage must be adjacent-migration')
    expect(() => assertSnapshotCorpusPolicy([
      { ...completeV0, retained: { version: 0, coverage: ['adjacent-migration'] } },
    ])).toThrow('session/v0: v0 retained coverage must be multi-hop, packed-row, retry-failure, shipped-profile')
  })

  it('rejects absent roles, undeclared history, and mixed selected generations', () => {
    expect(() => assertSnapshotCorpusPolicy([{ key: 'session/empty', selectedVersions: [] }]))
      .toThrow('session/empty: scenario owns no selected Session role')
    expect(() => assertSnapshotCorpusPolicy([{ key: 'session/old', selectedVersions: [1] }]))
      .toThrow(`session/old: selected Session generation v1 must be retained baseline v3 or current v${SESSION_FORMAT_VERSION}`)
    expect(() => assertSnapshotCorpusPolicy([{ ...completeV0, selectedVersions: [0, SESSION_FORMAT_VERSION] }]))
      .toThrow(`session/v0: selected Session generation v${SESSION_FORMAT_VERSION} does not match expected v0`)
    expect(() => assertSnapshotCorpusPolicy([{ ...baseline, selectedVersions: [3, SESSION_FORMAT_VERSION] }]))
      .toThrow(`session/v3: selected Session generation v${SESSION_FORMAT_VERSION} does not match expected v3`)
  })

  it('rejects future unpinned generations', () => {
    expect(() => assertSnapshotCorpusPolicy([{ key: 'session/future', selectedVersions: [SESSION_FORMAT_VERSION + 1] }]))
      .toThrow(`session/future: selected Session generation v${SESSION_FORMAT_VERSION + 1} must be retained baseline v3 or current v${SESSION_FORMAT_VERSION}`)
  })

  it.each([SESSION_FORMAT_VERSION, SESSION_FORMAT_VERSION + 1, -1, 0.5])(
    'rejects retained generation %s outside released history', (version) => {
      expect(() => assertSnapshotCorpusPolicy([{
        key: 'session/not-historical', selectedVersions: [version],
        retained: { version, coverage: ['adjacent-migration'] },
      }])).toThrow(`session/not-historical: retained Session format must precede current v${SESSION_FORMAT_VERSION}`)
    },
  )

  it('bounds explicitly retained roles and requires a baseline/current majority', () => {
    expect(assertSnapshotCorpusPolicy([
      baseline, current,
      { ...completeV0, selectedVersions: Array<number>(9).fill(0) }, ...adjacent,
    ]).retainedRoles).toBe(11)
    expect(() => assertSnapshotCorpusPolicy([
      baseline, current,
      { ...completeV0, selectedVersions: Array<number>(10).fill(0) }, ...adjacent,
    ])).toThrow('Session corpus retains 12 historical roles; maximum is 11')
    expect(() => assertSnapshotCorpusPolicy([
      { ...baseline, selectedVersions: [3] }, completeV0, ...adjacent,
    ])).toThrow(`Session corpus requires a baseline/current majority; baseline=1, current=0, retained=${1 + adjacent.length}`)
  })
})
