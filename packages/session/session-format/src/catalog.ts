import { createSessionFormatChain } from './chain.ts'
import { SessionFormatEventCollector } from './context.ts'
import { SessionFormatError, SessionFormatUnsupportedMigrationError } from './error.ts'
import {
  inspectSessionFormatVersion,
  snapshotSessionFormatHeader,
  sessionFormatVersion,
} from './json.ts'
import type {
  SessionFormatArtifact,
  SessionFormatArtifactDecoder,
  SessionFormatCatalog,
  SessionFormatCatalogOptions,
  SessionFormatCodec,
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatHeaderReadResult,
  SessionFormatMigrationContext,
  SessionFormatMigrationStream,
  SessionFormatRestore,
  SessionFormatRestoreOptions,
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

  function encodeCurrentHeader(
    header: Parameters<SessionFormatCatalog['encodeCurrentHeader']>[0],
    inheritedEventCount: number,
  ) {
    if (inspectSessionFormatVersion(header) !== chain.currentVersion) {
      throw new SessionFormatError(`encodeCurrent requires Session format v${chain.currentVersion}`)
    }
    const encoded = options.currentEncoder.encodeHeader(header, inheritedEventCount)
    if (inspectSessionFormatVersion(encoded) !== chain.currentVersion) {
      throw new SessionFormatError('current Session codec returned a non-current header')
    }
    return encoded
  }

  function createRestore(
    headerValue: unknown,
    restoreOptions: SessionFormatRestoreOptions,
  ): SessionFormatRestore {
    const { storedVersion, codec } = artifactCodec(headerValue)
    const decoder = codec.createDecoder(headerValue, restoreOptions.recovery)
    const sourceCut = decoder.headerInheritedEventCount
    if (storedVersion === chain.currentVersion) {
      return new CurrentSessionFormatRestore(
        decoder,
        sourceCut,
        restoreOptions.validation === 'current' ? options.restoreCurrent : identityArtifact,
        chain.currentVersion,
      )
    }
    const collector = new SessionFormatEventCollector()
    const migration = chain.createStream(
      decoder.header,
      requiredHistoricalCut(storedVersion, sourceCut),
      collector,
    )
    return new MigratingSessionFormatRestore(
      decoder,
      sourceCut,
      migration,
      collector,
      restoreOptions.validation === 'current'
        ? options.restoreCurrent
        : options.restoreTransformedCurrent,
      restoreOptions.validation,
      storedVersion,
      chain.currentVersion,
    )
  }

  return Object.freeze({
    currentVersion: chain.currentVersion,
    readHeader,
    createRestore,
    encodeCurrentHeader,
    encodeCurrentEvent: options.currentEncoder.encodeEvent.bind(options.currentEncoder),
  })
}

type SessionFormatArtifactRestorer = (artifact: SessionFormatArtifact) => SessionFormatArtifact

class CurrentSessionFormatRestore implements SessionFormatRestore {
  readonly header: SessionFormatArtifact['header']
  private readonly collector = new SessionFormatEventCollector()

  constructor(
    private readonly decoder: SessionFormatArtifactDecoder,
    private readonly sourceInheritedEventCount: number | undefined,
    private readonly restoreArtifact: SessionFormatArtifactRestorer,
    private readonly currentVersion: number,
  ) {
    this.header = decoder.header
  }

  decodeRow(rowValue: unknown): void {
    this.decoder.decodeRow(rowValue, this.collector)
  }

  finish(): SessionFormatArtifact {
    const inheritedEventCount = finishDecoder(
      this.decoder,
      this.collector,
      this.sourceInheritedEventCount,
    )
    return restoreCurrentVersion(this.restoreArtifact({
      header: this.header,
      inheritedEventCount,
      events: this.collector.values,
    }), this.currentVersion)
  }
}

class MigratingSessionFormatRestore implements
  SessionFormatRestore,
  SessionFormatMigrationContext {
  readonly header: SessionFormatArtifact['header']

  constructor(
    private readonly decoder: SessionFormatArtifactDecoder,
    private readonly sourceInheritedEventCount: number | undefined,
    private readonly migration: SessionFormatMigrationStream,
    private readonly collector: SessionFormatEventCollector,
    private readonly restoreArtifact: SessionFormatArtifactRestorer,
    private readonly validation: SessionFormatRestoreOptions['validation'],
    private readonly sourceVersion: number,
    private readonly currentVersion: number,
  ) {
    this.header = migration.header
  }

  decodeRow(rowValue: unknown): void {
    this.decoder.decodeRow(rowValue, this)
  }

  emitEvent(event: SessionFormatEvent): void {
    this.migration.emitEvent(event)
  }

  emitRun(run: SessionFormatEventRun): void {
    this.migration.emitRun(run)
  }

  finish(): SessionFormatArtifact {
    finishDecoder(this.decoder, this, this.sourceInheritedEventCount)
    const artifact = {
      header: this.header,
      inheritedEventCount: this.migration.finish(),
      events: this.collector.values,
    }
    let restored: SessionFormatArtifact
    try {
      restored = this.restoreArtifact(artifact)
    } catch (error: unknown) {
      if (this.validation === 'current'
        || error instanceof SessionFormatUnsupportedMigrationError) throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new SessionFormatUnsupportedMigrationError(
        `Session migration from v${this.sourceVersion} to v${this.currentVersion} refuses the transformed artifact: ${detail}`,
        { cause: error },
      )
    }
    return restoreCurrentVersion(restored, this.currentVersion)
  }
}

function finishDecoder(
  decoder: SessionFormatArtifactDecoder,
  context: SessionFormatMigrationContext,
  sourceInheritedEventCount: number | undefined,
): number {
  const inheritedEventCount = decoder.finish(context)
  if (sourceInheritedEventCount !== undefined && inheritedEventCount !== sourceInheritedEventCount) {
    throw new SessionFormatError('streaming decoder changed its predeclared inherited cut')
  }
  return inheritedEventCount
}

function restoreCurrentVersion(
  artifact: SessionFormatArtifact,
  currentVersion: number,
): SessionFormatArtifact {
  if (artifact.header.version !== currentVersion) {
    throw new SessionFormatError(
      `current Session restorer returned v${artifact.header.version}; expected v${currentVersion}`,
    )
  }
  return artifact
}

function identityArtifact(artifact: SessionFormatArtifact): SessionFormatArtifact {
  return artifact
}

function requiredHistoricalCut(version: number, cut: number | undefined): number {
  if (cut === undefined) {
    throw new SessionFormatError(`format v${version} decoder must expose its inherited cut before migration`)
  }
  return cut
}

function malformed(targetVersion: number, error: unknown, storedVersion?: number): SessionFormatHeaderReadResult {
  return Object.freeze({
    status: 'malformed',
    ...(storedVersion === undefined ? {} : { storedVersion }),
    targetVersion,
    reason: error instanceof Error ? error.message : String(error),
  })
}
