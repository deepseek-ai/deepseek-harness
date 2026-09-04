import { describe, expect, it, vi } from 'vitest'
import {
  createSessionFormatChain,
  defineSessionFormatMigration,
  SessionFormatUnsupportedMigrationError,
  type SessionFormatArtifact,
} from '../src/index.ts'

const currentArtifact: SessionFormatArtifact = {
  header: {
    version: 1,
    id: 'session-1',
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
  },
  inheritedEventCount: 0,
  events: [{ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }],
}

function captureError(run: () => unknown): Error {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof Error) return error
    throw new Error('expected an Error object', { cause: error })
  }
  throw new Error('expected callback to throw')
}

describe('Session format chain', () => {
  it('restores current input without invoking an adjacent migration', () => {
    const migrate = vi.fn()
    const chain = createSessionFormatChain({
      currentVersion: 1,
      migrations: [defineSessionFormatMigration({
        name: '@test/v0-to-v1',
        fromVersion: 0,
        toVersion: 1,
        migrateHeader: header => ({ ...header, version: 1 }),
        migrate,
        validateTarget: () => {},
        validateTargetHeader: () => {},
      })],
      restoreCurrent: artifact => artifact,
      restoreCurrentHeader: header => header,
    })

    const result = chain.migrate(currentArtifact)

    expect(result).toEqual(currentArtifact)
    expect(result).not.toBe(currentArtifact)
    expect(Object.isFrozen(result)).toBe(true)
    expect(migrate).not.toHaveBeenCalled()
  })

  it('runs one adjacent whole-artifact edge and its header converter', () => {
    const validateTarget = vi.fn()
    const edge = defineSessionFormatMigration({
      name: '@test/v0-to-v1',
      fromVersion: 0,
      toVersion: 1,
      migrateHeader: header => ({ ...header, version: 1 }),
      migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
      validateTarget,
      validateTargetHeader: () => {},
    })
    const chain = createSessionFormatChain({
      currentVersion: 1,
      migrations: [edge],
      restoreCurrent: value => value,
      restoreCurrentHeader: value => value,
    })
    const source = { ...currentArtifact, header: { ...currentArtifact.header, version: 0 } }

    expect(chain.plan(0)).toEqual([edge])
    expect(chain.migrate(source)).toMatchObject({ header: { version: 1 } })
    expect(validateTarget).toHaveBeenCalledOnce()
    expect(chain.migrateHeader(source.header).version).toBe(1)
  })

  it('rejects invalid declarations and incomplete chain construction', () => {
    const base = {
      name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
      migrateHeader: (header: SessionFormatArtifact['header']) => ({ ...header, version: 1 }),
      migrate: (artifact: SessionFormatArtifact) => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
      validateTarget: () => {},
      validateTargetHeader: () => {},
    }
    expect(() => defineSessionFormatMigration({ ...base, name: '' })).toThrow(/name/)
    expect(() => defineSessionFormatMigration({ ...base, toVersion: 2 })).toThrow(/adjacent/)
    expect(() => createSessionFormatChain({
      currentVersion: 1, migrations: [], restoreCurrent: value => value, restoreCurrentHeader: value => value,
    }))
      .toThrow(/missing/)
    expect(() => createSessionFormatChain({
      currentVersion: 1, migrations: [base, base], restoreCurrent: value => value, restoreCurrentHeader: value => value,
    }))
      .toThrow(/duplicated/)
    expect(() => createSessionFormatChain({
      currentVersion: 2,
      migrations: [base, { ...base, name: base.name, fromVersion: 1, toVersion: 2 }],
      restoreCurrent: value => value,
      restoreCurrentHeader: value => value,
    })).toThrow(/name .* duplicated/)
    expect(() => createSessionFormatChain({
      currentVersion: 1,
      migrations: [base, { ...base, name: '@test/v1-to-v2', fromVersion: 1, toVersion: 2 }],
      restoreCurrent: value => value,
      restoreCurrentHeader: value => value,
    })).toThrow(/does not lead/)
  })

  it('rejects newer inputs and callbacks that return the wrong version', () => {
    const edge = defineSessionFormatMigration({
      name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
      migrateHeader: header => header,
      migrate: artifact => artifact,
      validateTarget: () => {},
      validateTargetHeader: () => {},
    })
    const chain = createSessionFormatChain({
      currentVersion: 1, migrations: [edge], restoreCurrent: value => value, restoreCurrentHeader: value => value,
    })
    const source = { ...currentArtifact, header: { ...currentArtifact.header, version: 0 } }
    expect(() => chain.plan(2)).toThrow(/newer/)
    expect(() => chain.plan(-1)).toThrow(/non-negative/)
    expect(() => chain.migrate(source)).toThrow(/returned v0/)
    expect(() => chain.migrateHeader(source.header)).toThrow(/header returned v0/)

    const badRestore = createSessionFormatChain({
      currentVersion: 1,
      migrations: [defineSessionFormatMigration({
        ...edge,
        migrateHeader: header => ({ ...header, version: 1 }),
        migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
      })],
      restoreCurrent: value => ({ ...value, header: { ...value.header, version: 0 } }),
      restoreCurrentHeader: value => value,
    })
    expect(() => badRestore.migrate(currentArtifact)).toThrow(/current Session restorer returned v0/)
  })

  it('classifies adjacent target-policy refusal as unsupported but current restoration failure as corruption', () => {
    const policyFailure = new Error('target relationship is invalid')
    const edge = defineSessionFormatMigration({
      name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
      migrateHeader: header => ({ ...header, version: 1 }),
      migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
      validateTarget: () => { throw policyFailure },
      validateTargetHeader: () => {},
    })
    const chain = createSessionFormatChain({
      currentVersion: 1,
      migrations: [edge],
      restoreCurrent: value => value,
      restoreCurrentHeader: value => value,
    })
    const source = { ...currentArtifact, header: { ...currentArtifact.header, version: 0 } }

    const refusal = captureError(() => chain.migrate(source))
    expect(refusal).toBeInstanceOf(SessionFormatUnsupportedMigrationError)
    expect(refusal.message).toContain('target relationship is invalid')
    expect(refusal.cause).toBe(policyFailure)

    const brokenCurrent = createSessionFormatChain({
      currentVersion: 1,
      migrations: [edge],
      restoreCurrent: () => { throw new Error('current corruption') },
      restoreCurrentHeader: value => value,
    })
    expect(() => brokenCurrent.migrate(currentArtifact)).toThrow('current corruption')

    const migrationFailure = createSessionFormatChain({
      currentVersion: 1,
      migrations: [{
        ...edge,
        migrate: () => { throw 'source policy token' },
        validateTarget: () => {},
      }],
      restoreCurrent: value => value,
      restoreCurrentHeader: value => value,
    })
    expect(() => migrationFailure.migrate(source)).toThrow(/source policy token/)

    const alreadyUnsupported = new SessionFormatUnsupportedMigrationError('explicit edge refusal')
    const preserved = createSessionFormatChain({
      currentVersion: 1,
      migrations: [{ ...edge, validateTarget: () => { throw alreadyUnsupported } }],
      restoreCurrent: value => value,
      restoreCurrentHeader: value => value,
    })
    expect(() => preserved.migrate(source)).toThrow(alreadyUnsupported)
  })

  it('validates every adjacent target header and the final current header', () => {
    const validateTargetHeader = vi.fn((header: SessionFormatArtifact['header']) => {
      if (header['targetMarker'] !== true) throw new Error('target header lacks marker')
    })
    const restoreCurrentHeader = vi.fn((header: SessionFormatArtifact['header']) => {
      if (typeof header.id !== 'string') throw new Error('current header lacks id')
      return header
    })
    const edge = defineSessionFormatMigration({
      name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
      migrateHeader: header => ({ ...header, version: 1 }),
      migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
      validateTarget: () => {},
      validateTargetHeader,
    })
    const chain = createSessionFormatChain({
      currentVersion: 1,
      migrations: [edge],
      restoreCurrent: value => value,
      restoreCurrentHeader,
    })
    const source = { ...currentArtifact.header, version: 0 }

    const refusal = captureError(() => chain.migrateHeader(source))
    expect(refusal).toBeInstanceOf(SessionFormatUnsupportedMigrationError)
    expect(refusal.message).toContain('target header lacks marker')
    expect(validateTargetHeader).toHaveBeenCalledOnce()

    const rejectingHeader = createSessionFormatChain({
      currentVersion: 1,
      migrations: [{
        ...edge,
        migrateHeader: () => { throw new Error('historical header policy') },
      }],
      restoreCurrent: value => value,
      restoreCurrentHeader,
    })
    expect(() => rejectingHeader.migrateHeader(source)).toThrow(/historical header policy/)

    const badCurrent = createSessionFormatChain({
      currentVersion: 1,
      migrations: [edge],
      restoreCurrent: value => value,
      restoreCurrentHeader: () => ({ version: 1 } as never),
    })
    expect(() => badCurrent.migrateHeader(currentArtifact.header)).toThrow(/current Session header restoration id/)

    const wrongCurrentVersion = createSessionFormatChain({
      currentVersion: 1,
      migrations: [edge],
      restoreCurrent: value => value,
      restoreCurrentHeader: header => ({ ...header, version: 0 }),
    })
    expect(() => wrongCurrentVersion.migrateHeader(currentArtifact.header)).toThrow(/header restorer returned v0/)
  })
})
