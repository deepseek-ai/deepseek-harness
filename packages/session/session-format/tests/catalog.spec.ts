import { describe, expect, it, vi } from 'vitest'
import {
  createSessionFormatCatalog,
  defineSessionFormatMigration,
  type SessionFormatArtifact,
  type SessionFormatCodec,
} from '../src/index.ts'

function codec(version: number) {
  return {
    version,
    decodeHeader(value: unknown) {
      return value as never
    },
    decodeArtifact(headerValue: unknown, rowValues: readonly unknown[]) {
      const header = headerValue as SessionFormatArtifact['header']
      return {
        header,
        inheritedEventCount: 0,
        events: rowValues as SessionFormatArtifact['events'],
      }
    },
    decodeRecoverableArtifact(headerValue: unknown, rowValues: readonly unknown[]) {
      return this.decodeArtifact(headerValue, rowValues)
    },
    encodeArtifact(artifact: SessionFormatArtifact) {
      return { header: artifact.header, rows: artifact.events }
    },
  }
}

describe('Session format catalog', () => {
  it('classifies headers without reading bodies and dispatches physical values by version', () => {
    const migrate = vi.fn((artifact: SessionFormatArtifact): SessionFormatArtifact => ({
      ...artifact,
      header: { ...artifact.header, version: 1 },
    }))
    const catalog = createSessionFormatCatalog({
      currentVersion: 1,
      codecs: [codec(0), codec(1)],
      encodeCurrentArtifact: (artifact: SessionFormatArtifact) => codec(1).encodeArtifact(artifact),
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
    const oldHeader = {
      version: 0,
      id: 'old',
      createdAt: 1,
      isSeeded: true,
      delegationDepth: 0,
    } as const

    expect(catalog.readHeader(oldHeader)).toEqual({
      status: 'migration-required',
      storedVersion: 0,
      targetVersion: 1,
      header: { ...oldHeader, version: 1 },
    })
    expect(catalog.readHeader({ version: 2 })).toMatchObject({
      status: 'unsupported',
      storedVersion: 2,
      targetVersion: 1,
    })
    expect(catalog.readHeader({ version: 'broken' })).toMatchObject({ status: 'malformed', targetVersion: 1 })

    const decoded = catalog.decodeArtifact(oldHeader, [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    ])
    expect(decoded.header.version).toBe(0)
    expect(catalog.migrate(decoded).header.version).toBe(1)
    expect(migrate).toHaveBeenCalledOnce()
  })

  it('uses the current codec directly for recovery and encoding', () => {
    const currentCodec = codec(1)
    const catalog = createSessionFormatCatalog({
      currentVersion: 1,
      codecs: [codec(0), currentCodec],
      encodeCurrentArtifact: artifact => currentCodec.encodeArtifact(artifact),
      migrations: [defineSessionFormatMigration({
        name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
        migrateHeader: header => ({ ...header, version: 1 }),
        migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
        validateTarget: () => {},
        validateTargetHeader: () => {},
      })],
      restoreCurrent: artifact => artifact,
      restoreCurrentHeader: header => header,
    })
    const current = {
      header: {
        version: 1, id: 'current', createdAt: 1, isSeeded: false, delegationDepth: 0,
      },
      inheritedEventCount: 0,
      events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
    } satisfies SessionFormatArtifact

    expect(catalog.readHeader(current.header)).toMatchObject({ status: 'current', header: current.header })
    expect(catalog.decodeRecoverableArtifact(current.header, current.events)).toEqual(current)
    expect(catalog.encodeCurrent(current)).toEqual({
      header: current.header,
      rows: current.events,
    })
    expect(() => catalog.encodeCurrent({ ...current, header: { ...current.header, version: 0 } }))
      .toThrow(/requires Session format v1/)
  })

  it('rejects duplicate, missing, and future codec declarations', () => {
    const edge = defineSessionFormatMigration({
      name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
      migrateHeader: header => ({ ...header, version: 1 }),
      migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
      validateTarget: () => {},
      validateTargetHeader: () => {},
    })
    const options = {
      currentVersion: 1,
      migrations: [edge],
      encodeCurrentArtifact: (artifact: SessionFormatArtifact) => codec(1).encodeArtifact(artifact),
      restoreCurrent: (value: SessionFormatArtifact) => value,
      restoreCurrentHeader: (value: SessionFormatArtifact['header']) => value,
    }
    expect(() => createSessionFormatCatalog({ ...options, codecs: [codec(0), codec(0), codec(1)] }))
      .toThrow(/codec v0 is duplicated/)
    expect(() => createSessionFormatCatalog({ ...options, codecs: [codec(0)] })).toThrow(/codec v1 is missing/)
    expect(() => createSessionFormatCatalog({ ...options, codecs: [codec(0), codec(1), codec(2)] }))
      .toThrow(/codec v2 is newer/)
  })

  it('returns malformed descriptors for supported headers that their codec refuses', () => {
    const refusing: SessionFormatCodec = {
      ...codec(0),
      decodeHeader: () => { throw 'bad header' },
    }
    const catalog = createSessionFormatCatalog({
      currentVersion: 1,
      codecs: [refusing, codec(1)],
      encodeCurrentArtifact: artifact => codec(1).encodeArtifact(artifact),
      migrations: [defineSessionFormatMigration({
        name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
        migrateHeader: header => ({ ...header, version: 1 }),
        migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
        validateTarget: () => {},
        validateTargetHeader: () => {},
      })],
      restoreCurrent: artifact => artifact,
      restoreCurrentHeader: header => header,
    })
    expect(catalog.readHeader({ version: 0 })).toEqual({
      status: 'malformed', storedVersion: 0, targetVersion: 1, reason: 'bad header',
    })
    expect(() => catalog.decodeArtifact({ version: 2 }, [])).toThrow(/newer/)
    expect(() => catalog.decodeRecoverableArtifact({ version: 2 }, [])).toThrow(/newer/)
  })

  it('rejects a current encoder that returns a non-current header', () => {
    const bad = {
      ...codec(1),
      encodeArtifact: (artifact: SessionFormatArtifact) => ({
        header: { ...artifact.header, version: 0 }, rows: artifact.events,
      }),
    }
    const catalog = createSessionFormatCatalog({
      currentVersion: 1,
      codecs: [codec(0), bad],
      encodeCurrentArtifact: bad.encodeArtifact,
      migrations: [defineSessionFormatMigration({
        name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
        migrateHeader: header => ({ ...header, version: 1 }),
        migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
        validateTarget: () => {},
        validateTargetHeader: () => {},
      })],
      restoreCurrent: artifact => artifact,
      restoreCurrentHeader: header => header,
    })
    const current = {
      header: { version: 1, id: 'bad', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0,
      events: [],
    }
    expect(() => catalog.encodeCurrent(current)).toThrow(/non-current header/)
  })

  it('classifies malformed migrated and direct-current logical headers', () => {
    const validateTargetHeader = (header: SessionFormatArtifact['header']): void => {
      if (header['targetMarker'] !== true) throw new Error('latest header lacks marker')
    }
    const migration = defineSessionFormatMigration({
      name: '@test/v0-to-v1', fromVersion: 0, toVersion: 1,
      migrateHeader: header => ({ ...header, version: 1 }),
      migrate: artifact => ({ ...artifact, header: { ...artifact.header, version: 1 } }),
      validateTarget: () => {},
      validateTargetHeader,
    })
    const catalog = createSessionFormatCatalog({
      currentVersion: 1,
      codecs: [codec(0), codec(1)],
      encodeCurrentArtifact: artifact => codec(1).encodeArtifact(artifact),
      migrations: [migration],
      restoreCurrent: artifact => artifact,
      restoreCurrentHeader: (header: SessionFormatArtifact['header']) => {
        if (typeof header.id !== 'string') throw new Error('latest header lacks id')
        return header
      },
    })

    const migrated = catalog.readHeader({
      version: 0, id: 'old', createdAt: 1, isSeeded: false, delegationDepth: 0,
    })
    expect(migrated.status).toBe('unsupported')
    if (migrated.status !== 'unsupported') throw new Error('expected unsupported header')
    expect(migrated.reason).toContain('latest header lacks marker')
    const current = catalog.readHeader({ version: 1 })
    expect(current.status).toBe('malformed')
    if (current.status !== 'malformed') throw new Error('expected malformed current header')
    expect(current.reason).toMatch(/id/)
  })
})
