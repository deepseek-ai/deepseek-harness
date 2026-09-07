import { describe, expect, it, vi } from 'vitest'
import {
  createSessionFormatCatalog,
  SessionFormatUnsupportedMigrationError,
  type SessionFormatArtifact,
  type SessionFormatCatalogOptions,
  type SessionFormatCodec,
  type SessionFormatCurrentEncoder,
  type SessionFormatEvent,
  type SessionFormatEventRun,
  type SessionFormatMigration,
  type SessionFormatMigrationContext,
  type SessionFormatMigrationStageInput,
} from '../src/index.ts'

function codec(version: number, inheritedEventCount = 0): SessionFormatCodec & SessionFormatCurrentEncoder {
  return {
    version,
    decodeHeader(value: unknown) {
      return value as SessionFormatArtifact['header']
    },
    createDecoder(headerValue: unknown) {
      return {
        header: headerValue as SessionFormatArtifact['header'],
        headerInheritedEventCount: inheritedEventCount,
        decodeRow(rowValue: unknown, context: SessionFormatMigrationContext) {
          context.emitEvent(rowValue as SessionFormatEvent)
        },
        finish: () => inheritedEventCount,
      }
    },
    encodeHeader(header) {
      return header
    },
    encodeEvent(event) {
      return event
    },
  }
}

function identityMigrationStage(inheritedEventCount: number) {
  return {
    headerInheritedEventCount: inheritedEventCount,
    transformEvent(
      event: SessionFormatEvent,
      context: SessionFormatMigrationContext,
    ) {
      context.emitEvent(event)
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

function edge(overrides: Partial<SessionFormatMigration> = {}): SessionFormatMigration {
  return {
    name: '@test/v0-to-v1',
    fromVersion: 0,
    toVersion: 1,
    migrateHeader: header => ({ ...header, version: 1 }),
    createStage: ({ sourceInheritedEventCount }) => identityMigrationStage(sourceInheritedEventCount),
    validateTargetHeader: () => {},
    ...overrides,
  }
}

function catalog(
  migration: SessionFormatMigration = edge(),
  restoreVersion = 1,
  sourceCodec: SessionFormatCodec = codec(0),
  currentEncoder: SessionFormatCurrentEncoder = codec(1),
  restoreCurrentHeader: SessionFormatCatalogOptions['restoreCurrentHeader'] = header => header,
) {
  const currentCodec = codec(1)
  return createSessionFormatCatalog({
    currentVersion: 1,
    codecs: [sourceCodec, currentCodec],
    currentEncoder,
    migrations: [migration],
    restoreCurrent: artifact => ({
      ...artifact,
      header: { ...artifact.header, version: restoreVersion },
    }),
    restoreTransformedCurrent: artifact => ({
      ...artifact,
      header: { ...artifact.header, version: restoreVersion },
    }),
    restoreCurrentHeader,
  })
}

const oldHeader = {
  version: 0,
  id: 'old',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
} as const

const event = { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } } as const

function throwUnknown(value: unknown): never {
  throw value
}

describe('Session format catalog', () => {
  it('classifies headers and restores physical rows through the compiled chain', () => {
    const createStage = vi.fn(({ sourceInheritedEventCount }: SessionFormatMigrationStageInput) =>
      identityMigrationStage(sourceInheritedEventCount))
    const current = catalog(edge({ createStage }))

    expect(current.readHeader(oldHeader)).toEqual({
      status: 'migration-required',
      storedVersion: 0,
      targetVersion: 1,
      header: { ...oldHeader, version: 1 },
    })
    expect(current.readHeader({ version: 2 })).toMatchObject({
      status: 'unsupported', storedVersion: 2, targetVersion: 1,
    })
    expect(current.readHeader({ ...oldHeader, version: 1 })).toMatchObject({
      status: 'current', storedVersion: 1, targetVersion: 1,
    })
    expect(current.readHeader({ version: 'broken' })).toMatchObject({ status: 'malformed', targetVersion: 1 })

    const restore = current.createRestore(oldHeader, { recovery: 'strict', validation: 'current' })
    restore.decodeRow(event)
    expect(restore.finish()).toMatchObject({ header: { version: 1 }, events: [event] })
    expect(createStage).toHaveBeenCalledOnce()
  })

  it('restores current rows without a migration and encodes one record at a time', () => {
    const current = catalog()
    const header = { ...oldHeader, version: 1 }
    const restore = current.createRestore(header, { recovery: 'strict', validation: 'current' })
    restore.decodeRow(event)

    expect(restore.finish()).toEqual({ header, inheritedEventCount: 0, events: [event] })
    expect(current.encodeCurrentHeader(header, 0)).toEqual(header)
    expect(current.encodeCurrentEvent(event)).toEqual(event)
    expect(() => current.encodeCurrentHeader(oldHeader, 0)).toThrow(/requires Session format v1/)

    const physicalOnly = current.createRestore(header, { recovery: 'strict', validation: 'transformed' })
    physicalOnly.decodeRow(event)
    expect(physicalOnly.finish()).toEqual({ header, inheritedEventCount: 0, events: [event] })

    const transformed = current.createRestore(oldHeader, { recovery: 'strict', validation: 'transformed' })
    transformed.decodeRow(event)
    expect(transformed.finish()).toMatchObject({ header: { version: 1 }, events: [event] })
  })

  it.each([
    new Error('target artifact is incompatible'),
    'non-Error target artifact refusal',
  ])('classifies migrated target validation failures as unsupported', (targetFailure) => {
    const current = createSessionFormatCatalog({
      currentVersion: 1,
      codecs: [codec(0), codec(1)],
      currentEncoder: codec(1),
      migrations: [edge()],
      restoreCurrent: artifact => artifact,
      restoreTransformedCurrent: () => { throw targetFailure },
      restoreCurrentHeader: header => header,
    })
    const restore = current.createRestore(oldHeader, { recovery: 'strict', validation: 'transformed' })
    restore.decodeRow(event)

    try {
      restore.finish()
      throw new Error('expected transformed target validation to fail')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SessionFormatUnsupportedMigrationError)
      expect((error as Error).cause).toBe(targetFailure)
    }
  })

  it('preserves current-validation failures and explicit migration refusals', () => {
    const currentFailure = new Error('installed current validation failed')
    const current = createSessionFormatCatalog({
      currentVersion: 1,
      codecs: [codec(0), codec(1)],
      currentEncoder: codec(1),
      migrations: [edge()],
      restoreCurrent: () => { throw currentFailure },
      restoreTransformedCurrent: artifact => artifact,
      restoreCurrentHeader: header => header,
    }).createRestore(oldHeader, { recovery: 'strict', validation: 'current' })
    expect(() => current.finish()).toThrow(currentFailure)

    const explicit = new SessionFormatUnsupportedMigrationError('explicit target refusal')
    const transformed = createSessionFormatCatalog({
      currentVersion: 1,
      codecs: [codec(0), codec(1)],
      currentEncoder: codec(1),
      migrations: [edge()],
      restoreCurrent: artifact => artifact,
      restoreTransformedCurrent: () => { throw explicit },
      restoreCurrentHeader: header => header,
    }).createRestore(oldHeader, { recovery: 'strict', validation: 'transformed' })
    expect(() => transformed.finish()).toThrow(explicit)
  })

  it('rejects a current encoder that returns a non-current header', () => {
    const badEncoder: SessionFormatCurrentEncoder = {
      ...codec(1),
      encodeHeader: header => ({ ...header, version: 0 }),
    }
    const current = catalog(edge(), 1, codec(0), badEncoder)

    expect(() => current.encodeCurrentHeader({ ...oldHeader, version: 1 }, 0))
      .toThrow(/non-current header/)
  })

  it('rejects duplicate, missing, and future codec declarations', () => {
    const options = {
      currentVersion: 1,
      migrations: [edge()],
      currentEncoder: codec(1),
      restoreCurrent: (value: SessionFormatArtifact) => value,
      restoreTransformedCurrent: (value: SessionFormatArtifact) => value,
      restoreCurrentHeader: (value: SessionFormatArtifact['header']) => value,
    }
    expect(() => createSessionFormatCatalog({ ...options, codecs: [codec(0), codec(0), codec(1)] }))
      .toThrow(/codec v0 is duplicated/)
    expect(() => createSessionFormatCatalog({ ...options, codecs: [codec(0)] })).toThrow(/codec v1 is missing/)
    expect(() => createSessionFormatCatalog({ ...options, codecs: [codec(0), codec(1), codec(2)] }))
      .toThrow(/codec v2 is newer/)
  })

  it('preserves unsupported header and migration failures', () => {
    const refusingCodec: SessionFormatCodec = {
      ...codec(0),
      decodeHeader: () => { throw new Error('bad header') },
      createDecoder: () => { throw new Error('bad body') },
    }
    const current = catalog(edge(), 1, refusingCodec)
    expect(current.readHeader(oldHeader)).toMatchObject({ status: 'malformed', reason: 'bad header' })
    expect(() => current.createRestore(oldHeader, { recovery: 'strict', validation: 'current' }))
      .toThrow('bad body')
    expect(() => current.createRestore({ version: 2 }, { recovery: 'strict', validation: 'current' }))
      .toThrow(/newer/)

    const nonError = catalog({
      ...edge(),
    }, 1, {
      ...codec(0),
      decodeHeader: () => throwUnknown('non-Error header failure'),
    })
    expect(nonError.readHeader(oldHeader)).toMatchObject({
      status: 'malformed', reason: 'non-Error header failure',
    })
  })

  it('classifies migrated header refusals as unsupported and current corruption as malformed', () => {
    const unsupported = catalog(edge({
      validateTargetHeader: () => { throw new Error('target header lacks marker') },
    }))
    expect(unsupported.readHeader(oldHeader)).toMatchObject({
      status: 'unsupported',
      reason: expect.stringContaining('target header lacks marker') as string,
    })

    const malformed = catalog(
      edge(),
      1,
      codec(0),
      codec(1),
      () => { throw new Error('current header is corrupt') },
    )
    expect(malformed.readHeader({ ...oldHeader, version: 1 })).toMatchObject({
      status: 'malformed',
      reason: 'current header is corrupt',
    })
  })

  it('enforces decoder, stage, and restorer lifecycle results', () => {
    const changedCut = edge({
      createStage: () => ({
        headerInheritedEventCount: 1,
        transformEvent: (candidate, context) => { context.emitEvent(candidate) },
        transformRun: (candidate, context) => { context.emitRun(candidate) },
        finish: () => 0,
      }),
    })
    const changed = catalog(changedCut, 1, codec(0, 1)).createRestore(
      { ...oldHeader, isSeeded: true },
      { recovery: 'strict', validation: 'current' },
    )
    expect(() => changed.finish()).toThrow(/changed its predeclared inherited cut/)

    const trailing = catalog(edge({
      createStage: () => ({
        headerInheritedEventCount: 0,
        transformEvent: () => {},
        transformRun: () => {},
        finish: (context) => { context.emitEvent(event); return 0 },
      }),
    })).createRestore(oldHeader, { recovery: 'strict', validation: 'current' })
    expect(trailing.finish().events).toEqual([event])

    const wrongVersion = catalog(edge(), 0).createRestore(
      oldHeader,
      { recovery: 'strict', validation: 'current' },
    )
    expect(() => wrongVersion.finish()).toThrow(/returned v0/)

    const changedDecoderCut: SessionFormatCodec = {
      ...codec(0),
      createDecoder(headerValue) {
        return {
          header: headerValue as SessionFormatArtifact['header'],
          headerInheritedEventCount: 0,
          decodeRow: () => {},
          finish: () => 1,
        }
      },
    }
    const changedDecoder = catalog(edge(), 1, changedDecoderCut).createRestore(
      oldHeader,
      { recovery: 'strict', validation: 'current' },
    )
    expect(() => changedDecoder.finish()).toThrow(/decoder changed its predeclared inherited cut/)

    const deferredCut: SessionFormatCodec = {
      ...codec(0),
      createDecoder(headerValue) {
        return {
          header: headerValue as SessionFormatArtifact['header'],
          decodeRow: () => {},
          finish: () => 0,
        }
      },
    }
    expect(() => catalog(edge(), 1, deferredCut).createRestore(
      oldHeader,
      { recovery: 'strict', validation: 'current' },
    )).toThrow(/must expose its inherited cut/)
  })

  it('expands an unhandled compact run without an intermediate array', () => {
    const run: SessionFormatEventRun = {
      runType: 'test-run', firstSeq: 0, eventCount: 1, expand: function* () { yield event },
    }
    const source: SessionFormatCodec = {
      ...codec(0),
      createDecoder(headerValue) {
        return {
          header: headerValue as SessionFormatArtifact['header'],
          headerInheritedEventCount: 0,
          decodeRow(_rowValue, context) { context.emitRun(run) },
          finish: () => 0,
        }
      },
    }
    const restore = catalog(edge(), 1, source).createRestore(
      oldHeader,
      { recovery: 'strict', validation: 'current' },
    )
    restore.decodeRow({})

    expect(restore.finish().events).toEqual([event])
  })
})
