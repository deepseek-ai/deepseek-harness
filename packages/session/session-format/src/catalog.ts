import { createSessionFormatChain } from './chain.ts'
import { SessionFormatError, SessionFormatUnsupportedMigrationError } from './error.ts'
import {
  inspectSessionFormatVersion,
  snapshotSessionFormatArtifact,
  snapshotSessionFormatHeader,
  snapshotSessionFormatJson,
  sessionFormatVersion,
} from './json.ts'
import type {
  EncodedSessionFormatArtifact,
  SessionFormatCatalog,
  SessionFormatCatalogOptions,
  SessionFormatCodec,
  SessionFormatHeaderReadResult,
  SessionFormatJsonObject,
} from './types.ts'

/**
 * Compile a build-static physical codec and adjacent migration catalog.
 * @param options - complete codecs, migrations, current version, and restorer.
 * @returns immutable physical dispatch and migration operations.
 */
export function createSessionFormatCatalog(options: SessionFormatCatalogOptions): SessionFormatCatalog {
  const chain = createSessionFormatChain(options)
  const codecs = new Map<number, SessionFormatCodec>()
  for (const codec of options.codecs) {
    const version = sessionFormatVersion(codec.version, 'Session format codec version')
    if (codecs.has(version)) throw new SessionFormatError(`Session format codec v${version} is duplicated`)
    codecs.set(version, Object.freeze({ ...codec }))
  }
  for (let version = 0; version <= chain.currentVersion; version += 1) {
    if (!codecs.has(version)) throw new SessionFormatError(`Session format codec v${version} is missing`)
  }
  if (codecs.size !== chain.currentVersion + 1) {
    const invalid = [...codecs.keys()].find(version => version > chain.currentVersion) as number
    throw new SessionFormatError(`Session format codec v${invalid} is newer than current v${chain.currentVersion}`)
  }

  function readHeader(headerValue: unknown): SessionFormatHeaderReadResult {
    let storedVersion: number | undefined
    try {
      storedVersion = inspectSessionFormatVersion(headerValue)
    } catch (error: unknown) {
      return malformed(chain.currentVersion, error)
    }
    if (storedVersion > chain.currentVersion) {
      return Object.freeze({
        status: 'unsupported',
        storedVersion,
        targetVersion: chain.currentVersion,
        reason: `stored Session uses newer format v${storedVersion}; this build writes v${chain.currentVersion}`,
      })
    }
    const codec = codecs.get(storedVersion)
    /* v8 ignore next -- construction proves every supported version has exactly one codec. */
    if (codec === undefined) {
      return Object.freeze({
        status: 'unsupported',
        storedVersion,
        targetVersion: chain.currentVersion,
        reason: `this build has no Session format codec for v${storedVersion}`,
      })
    }
    try {
      const decoded = snapshotSessionFormatHeader(codec.decodeHeader(headerValue), `format v${storedVersion} header`)
      const header = chain.migrateHeader(decoded)
      return Object.freeze({
        status: storedVersion === chain.currentVersion ? 'current' : 'migration-required',
        storedVersion,
        targetVersion: chain.currentVersion,
        header,
      })
    } catch (error: unknown) {
      if (error instanceof SessionFormatUnsupportedMigrationError) {
        return Object.freeze({
          status: 'unsupported',
          storedVersion,
          targetVersion: chain.currentVersion,
          reason: error.message,
        })
      }
      return malformed(chain.currentVersion, error, storedVersion)
    }
  }

  function artifactCodec(headerValue: unknown): {
    readonly storedVersion: number
    readonly codec: SessionFormatCodec
  } {
    const storedVersion = inspectSessionFormatVersion(headerValue)
    if (storedVersion > chain.currentVersion) {
      throw new SessionFormatUnsupportedMigrationError(
        `stored Session uses newer format v${storedVersion}; this build writes v${chain.currentVersion}`,
      )
    }
    const codec = codecs.get(storedVersion)
    /* v8 ignore next -- construction proves every supported version has exactly one codec. */
    if (codec === undefined) {
      throw new SessionFormatUnsupportedMigrationError(`this build has no Session format codec for v${storedVersion}`)
    }
    return { storedVersion, codec }
  }

  function decodeArtifact(headerValue: unknown, rowValues: readonly unknown[]) {
    const { storedVersion, codec } = artifactCodec(headerValue)
    return snapshotSessionFormatArtifact(
      codec.decodeArtifact(headerValue, rowValues),
      `format v${storedVersion} decoded artifact`,
    )
  }

  function decodeRecoverableArtifact(headerValue: unknown, rowValues: readonly unknown[]) {
    const { storedVersion, codec } = artifactCodec(headerValue)
    return snapshotSessionFormatArtifact(
      codec.decodeRecoverableArtifact(headerValue, rowValues),
      `format v${storedVersion} recoverable artifact`,
    )
  }

  function encodeCurrent(
    artifact: Parameters<SessionFormatCatalog['encodeCurrent']>[0],
  ): EncodedSessionFormatArtifact {
    if (inspectSessionFormatVersion(artifact.header) !== chain.currentVersion) {
      throw new SessionFormatError(`encodeCurrent requires Session format v${chain.currentVersion}`)
    }
    const encoded = options.encodeCurrentArtifact(artifact)
    const header = snapshotSessionFormatJson(encoded.header, 'encoded current Session header') as SessionFormatJsonObject
    const rows = Object.freeze(encoded.rows.map((row, index) =>
      snapshotSessionFormatJson(row, `encoded current Session row ${index}`) as SessionFormatJsonObject))
    if (inspectSessionFormatVersion(header) !== chain.currentVersion) {
      throw new SessionFormatError('current Session codec returned a non-current header')
    }
    return Object.freeze({ header, rows })
  }

  return Object.freeze({
    currentVersion: chain.currentVersion,
    readHeader,
    decodeArtifact,
    decodeRecoverableArtifact,
    migrate: chain.migrate.bind(chain),
    encodeCurrent,
  })
}

function malformed(targetVersion: number, error: unknown, storedVersion?: number): SessionFormatHeaderReadResult {
  return Object.freeze({
    status: 'malformed',
    ...(storedVersion === undefined ? {} : { storedVersion }),
    targetVersion,
    reason: error instanceof Error ? error.message : String(error),
  })
}
