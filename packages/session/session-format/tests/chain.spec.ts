import { describe, expect, it, vi } from 'vitest'
import {
  createSessionFormatChain,
  defineSessionFormatMigration,
  SessionFormatEventCollector,
  SessionFormatUnsupportedMigrationError,
  type SessionFormatEvent,
  type SessionFormatEventRun,
  type SessionFormatHeader,
  type SessionFormatMigration,
  type SessionFormatMigrationContext,
  type SessionFormatMigrationStageInput,
} from '../src/index.ts'

const currentHeader: SessionFormatHeader = {
  version: 1,
  id: 'session-1',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
}

const event: SessionFormatEvent = {
  type: 'turn/start', seq: 0, time: 2, data: { turn: 1 },
}

const discard: SessionFormatMigrationContext = {
  emitEvent() {},
  emitRun() {},
}

function throwUnknown(value: unknown): never {
  throw value
}

function identityStage(inheritedEventCount: number) {
  return {
    headerInheritedEventCount: inheritedEventCount,
    transformEvent(
      value: SessionFormatEvent,
      context: SessionFormatMigrationContext,
    ) {
      context.emitEvent(value)
    },
    transformRun(
      run: SessionFormatEventRun,
      context: SessionFormatMigrationContext,
    ) {
      context.emitRun(run)
    },
    finish: () => inheritedEventCount,
  }
}

function migration(overrides: Partial<SessionFormatMigration> = {}): SessionFormatMigration {
  return {
    name: '@test/v0-to-v1',
    fromVersion: 0,
    toVersion: 1,
    migrateHeader: header => ({ ...header, version: 1 }),
    createStage: ({ sourceInheritedEventCount }) => identityStage(sourceInheritedEventCount),
    validateTargetHeader: () => {},
    ...overrides,
  }
}

function chain(edge: SessionFormatMigration = migration()) {
  return createSessionFormatChain({
    currentVersion: 1,
    migrations: [edge],
    restoreCurrentHeader: header => header,
  })
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
  it('bypasses adjacent stages for current input', () => {
    const createStage = vi.fn(({ sourceInheritedEventCount }: SessionFormatMigrationStageInput) =>
      identityStage(sourceInheritedEventCount))
    const current = chain(migration({ createStage }))
    const events = new SessionFormatEventCollector()
    const stream = current.createStream(currentHeader, 0, events)

    stream.emitEvent(event)

    expect(stream.header).toEqual(currentHeader)
    expect(stream.finish()).toBe(0)
    expect(events.values).toEqual([event])
    expect(createStage).not.toHaveBeenCalled()
  })

  it('composes one adjacent stage and its header conversion', () => {
    const current = chain()
    const sourceHeader = { ...currentHeader, version: 0 }
    const events = new SessionFormatEventCollector()
    const stream = current.createStream(sourceHeader, 0, events)

    stream.emitEvent(event)

    expect(stream.header.version).toBe(1)
    expect(stream.finish()).toBe(0)
    expect(events.values).toEqual([event])
    expect(current.migrateHeader(sourceHeader).version).toBe(1)
  })

  it('rejects invalid declarations and incomplete chain construction', () => {
    const base = migration()
    expect(() => defineSessionFormatMigration({ ...base, name: '' })).toThrow(/name/)
    expect(() => defineSessionFormatMigration({ ...base, toVersion: 2 })).toThrow(/adjacent/)
    expect(() => createSessionFormatChain({
      currentVersion: 1, migrations: [], restoreCurrentHeader: value => value,
    })).toThrow(/missing/)
    expect(() => createSessionFormatChain({
      currentVersion: 1, migrations: [base, base], restoreCurrentHeader: value => value,
    })).toThrow(/duplicated/)
    expect(() => createSessionFormatChain({
      currentVersion: 2,
      migrations: [base, { ...base, name: base.name, fromVersion: 1, toVersion: 2 }],
      restoreCurrentHeader: value => value,
    })).toThrow(/name .* duplicated/)
    expect(() => createSessionFormatChain({
      currentVersion: 1,
      migrations: [base, { ...base, name: '@test/v1-to-v2', fromVersion: 1, toVersion: 2 }],
      restoreCurrentHeader: value => value,
    })).toThrow(/does not lead/)
  })

  it('requires every intermediate stage to expose its inherited cut before the next edge', () => {
    const first = migration({
      createStage: () => ({
        transformEvent: (value, context) => { context.emitEvent(value) },
        transformRun: (value, context) => { context.emitRun(value) },
        finish: () => 0,
      }),
    })
    const second: SessionFormatMigration = {
      ...migration(),
      name: '@test/v1-to-v2',
      fromVersion: 1,
      toVersion: 2,
      migrateHeader: header => ({ ...header, version: 2 }),
    }
    const current = createSessionFormatChain({
      currentVersion: 2,
      migrations: [first, second],
      restoreCurrentHeader: header => header,
    })

    expect(() => current.createStream(
      { ...currentHeader, version: 0 },
      0,
      discard,
    )).toThrow(/expose its inherited cut/)

    const createSecondStage = vi.fn(({ sourceKind }: SessionFormatMigrationStageInput) => {
      expect(sourceKind).toBe('transformed')
      return identityStage(0)
    })
    const complete = createSessionFormatChain({
      currentVersion: 2,
      migrations: [migration(), { ...second, createStage: createSecondStage }],
      restoreCurrentHeader: header => header,
    })
    const stream = complete.createStream(
      { ...currentHeader, version: 0 },
      0,
      discard,
    )
    expect(stream.finish()).toBe(0)
    expect(createSecondStage).toHaveBeenCalledOnce()
  })

  it('rejects newer inputs and wrong header versions', () => {
    const current = chain(migration({ migrateHeader: header => header }))
    const source = { ...currentHeader, version: 0 }

    expect(() => current.createStream({ ...currentHeader, version: 2 }, 0, discard)).toThrow(/newer/)
    expect(() => current.createStream({ ...currentHeader, version: -1 }, 0, discard)).toThrow(/non-negative/)
    expect(() => current.createStream(source, 0, discard)).toThrow(/header returned v0/)
    expect(() => current.migrateHeader(source)).toThrow(/header returned v0/)
  })

  it('classifies stage failures as unsupported and preserves explicit refusals', () => {
    const policyFailure = new Error('target relationship is invalid')
    const source = { ...currentHeader, version: 0 }
    const failed = chain(migration({ createStage: () => { throw policyFailure } }))
    const refusal = captureError(() => failed.createStream(source, 0, discard))
    expect(refusal).toBeInstanceOf(SessionFormatUnsupportedMigrationError)
    expect(refusal.message).toContain('target relationship is invalid')
    expect(refusal.cause).toBe(policyFailure)

    const alreadyUnsupported = new SessionFormatUnsupportedMigrationError('explicit edge refusal')
    const preserved = chain(migration({ createStage: () => { throw alreadyUnsupported } }))
    expect(() => preserved.createStream(source, 0, discard)).toThrow(alreadyUnsupported)

    const finishFailure = new Error('finish relationship is invalid')
    const finishing = chain(migration({
      createStage: () => ({
        ...identityStage(0),
        finish: () => { throw finishFailure },
      }),
    })).createStream(source, 0, discard)
    const finishRefusal = captureError(() => finishing.finish())
    expect(finishRefusal).toBeInstanceOf(SessionFormatUnsupportedMigrationError)
    expect(finishRefusal.cause).toBe(finishFailure)

    const runFailure = new Error('run relationship is invalid')
    const runFailing = chain(migration({
      createStage: () => ({
        ...identityStage(0),
        transformRun: () => { throw runFailure },
      }),
    })).createStream(source, 0, discard)
    const runRefusal = captureError(() => {
      runFailing.emitRun({
        runType: 'test-run',
        firstSeq: 0,
        eventCount: 1,
        *expand() { yield event },
      })
    })
    expect(runRefusal).toBeInstanceOf(SessionFormatUnsupportedMigrationError)
    expect(runRefusal.cause).toBe(runFailure)

    const nonError = chain(migration({
      createStage: () => throwUnknown('non-Error stage refusal'),
    }))
    expect(() => nonError.createStream(source, 0, discard))
      .toThrow(/non-Error stage refusal/)
  })

  it('collects compact runs as expanded events', () => {
    const collector = new SessionFormatEventCollector()
    collector.emitRun({
      runType: 'test-run',
      firstSeq: 0,
      eventCount: 1,
      *expand() { yield event },
    })
    expect(collector.values).toEqual([event])
  })

  it('validates every adjacent target header and the final current header', () => {
    const validateTargetHeader = vi.fn((header: SessionFormatHeader) => {
      if (header['targetMarker'] !== true) throw new Error('target header lacks marker')
    })
    const restoreCurrentHeader = vi.fn((header: SessionFormatHeader) => {
      if (typeof header.id !== 'string') throw new Error('current header lacks id')
      return header
    })
    const current = createSessionFormatChain({
      currentVersion: 1,
      migrations: [migration({ validateTargetHeader })],
      restoreCurrentHeader,
    })
    const source = { ...currentHeader, version: 0 }

    const refusal = captureError(() => current.migrateHeader(source))
    expect(refusal).toBeInstanceOf(SessionFormatUnsupportedMigrationError)
    expect(refusal.message).toContain('target header lacks marker')
    expect(validateTargetHeader).toHaveBeenCalledOnce()

    const rejecting = createSessionFormatChain({
      currentVersion: 1,
      migrations: [migration({ migrateHeader: () => { throw new Error('historical header policy') } })],
      restoreCurrentHeader,
    })
    expect(() => rejecting.migrateHeader(source)).toThrow(/historical header policy/)

    const badCurrent = createSessionFormatChain({
      currentVersion: 1,
      migrations: [migration()],
      restoreCurrentHeader: () => ({ version: 1 } as never),
    })
    expect(() => badCurrent.migrateHeader(currentHeader)).toThrow(/current Session header restoration id/)

    const wrongCurrentVersion = createSessionFormatChain({
      currentVersion: 1,
      migrations: [migration()],
      restoreCurrentHeader: header => ({ ...header, version: 0 }),
    })
    expect(() => wrongCurrentVersion.migrateHeader(currentHeader)).toThrow(/header restorer returned v0/)
  })
})
