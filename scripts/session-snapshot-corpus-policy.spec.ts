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

const adjacent = Array.from({ length: SESSION_FORMAT_VERSION - 1 }, (_, index) => ({
  key: `sdk/v${index + 1}`,
  selectedVersions: [index + 1],
  retained: { version: index + 1, coverage: ['adjacent-migration'] as const },
}))
const current = { key: 'session/current', selectedVersions: Array<number>(8).fill(SESSION_FORMAT_VERSION) }

describe('recorded-session corpus policy', () => {
  it('accepts a current majority and complete bounded migration coverage', () => {
    expect(assertSnapshotCorpusPolicy([
      current,
      {
        key: 'session/multi-hop',
        selectedVersions: [0, 0, 0],
        retained: { version: 0, coverage: ['multi-hop', 'shipped-profile'] },
      },
      { key: 'session/packed', selectedVersions: [0], retained: { version: 0, coverage: ['packed-row'] } },
      { key: 'session/retry', selectedVersions: [0], retained: { version: 0, coverage: ['retry-failure'] } },
      ...adjacent,
    ])).toEqual({ currentRoles: 8, retainedRoles: 5 + adjacent.length, retainedScenarios: 3 + adjacent.length })
  })

  it('requires v0 coverage from v0 fixtures', () => {
    expect(() => assertSnapshotCorpusPolicy([current, ...adjacent]))
      .toThrow('Session corpus lacks v0 coverage')
  })

  it.each(adjacent)('requires direct coverage from $key', (fixture) => {
    expect(() => assertSnapshotCorpusPolicy([
      current, completeV0, ...adjacent.filter(other => other !== fixture),
    ])).toThrow(`Session corpus lacks v${fixture.retained.version} coverage: adjacent-migration`)
  })

  it('does not let one retained generation claim another edge\'s coverage', () => {
    expect(() => assertSnapshotCorpusPolicy([
      current,
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
      .toThrow(`session/old: selected Session generation v1 does not match expected v${SESSION_FORMAT_VERSION}`)
    expect(() => assertSnapshotCorpusPolicy([{ ...completeV0, selectedVersions: [0, SESSION_FORMAT_VERSION] }]))
      .toThrow(`session/v0: selected Session generation v${SESSION_FORMAT_VERSION} does not match expected v0`)
  })

  it.each([SESSION_FORMAT_VERSION, SESSION_FORMAT_VERSION + 1, -1, 0.5])(
    'rejects retained generation %s outside released history', (version) => {
      expect(() => assertSnapshotCorpusPolicy([{
        key: 'session/not-historical', selectedVersions: [version],
        retained: { version, coverage: ['adjacent-migration'] },
      }])).toThrow(`session/not-historical: retained Session format must precede current v${SESSION_FORMAT_VERSION}`)
    },
  )

  it('bounds historical roles and requires a current majority', () => {
    expect(() => assertSnapshotCorpusPolicy([
      { ...current, selectedVersions: Array<number>(20).fill(SESSION_FORMAT_VERSION) },
      { ...completeV0, selectedVersions: Array<number>(11).fill(0) },
      ...adjacent,
    ])).toThrow(`Session corpus retains ${11 + adjacent.length} historical roles; maximum is 10`)
    expect(() => assertSnapshotCorpusPolicy([
      { ...current, selectedVersions: [SESSION_FORMAT_VERSION] }, completeV0, ...adjacent,
    ])).toThrow(`Session corpus requires a current majority; current=1, retained=${1 + adjacent.length}`)
  })
})
