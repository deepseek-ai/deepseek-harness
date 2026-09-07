/** Scalar value admitted at the durable Session JSON boundary. */
export type SessionFormatJsonPrimitive = null | boolean | number | string

/** Lossless JSON value admitted at the durable Session boundary. */
export type SessionFormatJsonValue =
  | SessionFormatJsonPrimitive
  | readonly SessionFormatJsonValue[]
  | SessionFormatJsonObject

/** Lossless JSON object admitted at the durable Session boundary. */
export interface SessionFormatJsonObject {
  readonly [key: string]: SessionFormatJsonValue
}

/** Logical Session metadata shared by supported historical and current formats. */
export interface SessionFormatHeader extends SessionFormatJsonObject {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth: number
  readonly agentPreset?: string
}

/** One decoded logical Session event. */
export interface SessionFormatEvent extends SessionFormatJsonObject {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: SessionFormatJsonValue
}

/** One detached complete logical Session artifact. */
export interface SessionFormatArtifact {
  readonly header: SessionFormatHeader
  /** Exact inherited prefix length, available only after a body read. */
  readonly inheritedEventCount: number
  readonly events: readonly SessionFormatEvent[]
}

/** One independently maintained adjacent streaming migration. */
export interface SessionFormatMigration {
  readonly name: string
  readonly fromVersion: number
  readonly toVersion: number
  /** Convert one header without reading event bodies. */
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  /** Create the stateful body stage for one source artifact. */
  createStage(input: SessionFormatMigrationStageInput): SessionFormatMigrationStage
  /** Refuse any header that the adjacent target writer cannot emit. */
  validateTargetHeader(header: SessionFormatHeader): void
}

/** Headers and inherited cut supplied when one adjacent body stage is created. */
export interface SessionFormatMigrationStageInput {
  /** Validated source metadata for this adjacent edge. */
  readonly sourceHeader: SessionFormatHeader
  /** Validated target metadata produced by this edge's header migration. */
  readonly targetHeader: SessionFormatHeader
  /** Exact inherited prefix length in source coordinates. */
  readonly sourceInheritedEventCount: number
  /** Whether this edge consumes physical decode output or a prior migration's validated output. */
  readonly sourceKind: 'decoded' | 'transformed'
}

/** Inputs that compile the unique complete migration chain. */
export interface SessionFormatChainOptions {
  readonly currentVersion: number
  readonly migrations: readonly SessionFormatMigration[]
  /** Restore and validate a detached current header without reading event bodies. */
  readonly restoreCurrentHeader: (header: SessionFormatHeader) => SessionFormatHeader
}

/** Pure adjacent planner and streaming migration compiler. */
export interface SessionFormatChain {
  readonly currentVersion: number
  /** Compile the complete migration stage chain for one decoded source artifact. */
  createStream(
    header: SessionFormatHeader,
    inheritedEventCount: number,
    context: SessionFormatMigrationContext,
  ): SessionFormatMigrationStream
  /** Convert only a supported header to the current logical representation. */
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
}

/** Physical-row failure policy selected once for one restore. */
export type SessionFormatRecovery = 'strict' | 'recoverable'

/** Pure physical JSON codec frozen with one released Session format. */
export interface SessionFormatCodec {
  readonly version: number
  /** Decode one physical header into body-independent logical metadata. */
  decodeHeader(value: unknown): SessionFormatHeader
  /** Create one row-at-a-time decoder with an explicit failure policy. */
  createDecoder(headerValue: unknown, recovery: SessionFormatRecovery): SessionFormatArtifactDecoder
}

/** Stateful physical-row decoder used by streaming persistence restores. */
export interface SessionFormatArtifactDecoder {
  readonly header: SessionFormatHeader
  /** Inherited cut known before body decoding; current formats may derive it at EOF. */
  readonly headerInheritedEventCount?: number
  /** Decode one physical row and synchronously emit its events or compact run. */
  decodeRow(
    rowValue: unknown,
    context: SessionFormatMigrationContext,
  ): void
  /** Finish row validation and return the exact inherited cut. */
  finish(context: SessionFormatMigrationContext): number
}

/** Stateless physical record encoder for the installed current format. */
export interface SessionFormatCurrentEncoder {
  /** Encode the physical header record for one current artifact. */
  encodeHeader(header: SessionFormatHeader, inheritedEventCount: number): SessionFormatJsonObject
  /** Encode one current logical event as one physical record. */
  encodeEvent(event: SessionFormatEvent): SessionFormatJsonObject
}

/** A codec-owned compact run that adjacent migrations may consume without expanding. */
export interface SessionFormatEventRun {
  readonly runType: string
  readonly firstSeq: number
  readonly eventCount: number
  /** Expand the run for a migration that has no direct handler. */
  expand(): Iterable<SessionFormatEvent>
}

/** Synchronous output channel owned by a compiled migration stream. */
export interface SessionFormatMigrationContext {
  /** Deliver one settled event to the next stage before returning. */
  emitEvent(event: SessionFormatEvent): void
  /** Deliver one compact event run to the next stage before returning. */
  emitRun(run: SessionFormatEventRun): void
}

/** Stateful adjacent migration stage used by streaming persistence restores. */
export interface SessionFormatMigrationStage {
  /** Target inherited cut when it is unchanged and known before EOF. */
  readonly headerInheritedEventCount?: number
  /** Transform one source event and synchronously emit every settled target item. */
  transformEvent(
    event: SessionFormatEvent,
    context: SessionFormatMigrationContext,
  ): void
  /** Transform one compact source run without requiring an intermediate expansion array. */
  transformRun(
    run: SessionFormatEventRun,
    context: SessionFormatMigrationContext,
  ): void
  /** Emit trailing target items and return the exact target inherited cut. */
  finish(context: SessionFormatMigrationContext): number
}

/** One composed migration chain that emits settled current events to its owner. */
export interface SessionFormatMigrationStream extends SessionFormatMigrationContext {
  readonly header: SessionFormatHeader
  /** Settle all migration stages and return the exact current inherited cut. */
  finish(): number
}

/** Header-only classification that never inspects event rows. */
export type SessionFormatHeaderReadResult =
  | {
    readonly status: 'current' | 'migration-required'
    readonly storedVersion: number
    readonly targetVersion: number
    /** Latest logical header. The exact inherited cut requires a body read. */
    readonly header: SessionFormatHeader
  }
  | {
    readonly status: 'unsupported'
    readonly storedVersion: number
    readonly targetVersion: number
    readonly reason: string
  }
  | {
    readonly status: 'malformed'
    readonly storedVersion?: number
    readonly targetVersion: number
    readonly reason: string
  }

/** Inputs for a build-static physical codec and migration catalog. */
export interface SessionFormatCatalogOptions extends SessionFormatChainOptions {
  readonly codecs: readonly SessionFormatCodec[]
  /** Restore and validate a complete current artifact. */
  readonly restoreCurrent: (artifact: SessionFormatArtifact) => SessionFormatArtifact
  /** Encode current records without materializing an artifact-sized row array. */
  readonly currentEncoder: SessionFormatCurrentEncoder
  /** Validate an exclusively owned transformed artifact without copying or freezing it. */
  readonly restoreTransformedCurrent: (artifact: SessionFormatArtifact) => SessionFormatArtifact
}

/** Policies applied by one physical-row restore. */
export interface SessionFormatRestoreOptions {
  readonly recovery: SessionFormatRecovery
  /**
   * `current` applies all installed current-format validation. `transformed` applies
   * released current-format validation only after migration; current input receives only codec validation.
   */
  readonly validation: 'transformed' | 'current'
}

/** Build-static physical dispatch and adjacent migration catalog. */
export interface SessionFormatCatalog {
  readonly currentVersion: number
  /** Classify and translate one header without reading event rows. */
  readHeader(headerValue: unknown): SessionFormatHeaderReadResult
  /** Create one single-pass physical-row restore into current logical events. */
  createRestore(headerValue: unknown, options: SessionFormatRestoreOptions): SessionFormatRestore
  /** Encode one current physical header record. */
  encodeCurrentHeader(header: SessionFormatHeader, inheritedEventCount: number): SessionFormatJsonObject
  /** Encode one current physical event record. */
  encodeCurrentEvent(event: SessionFormatEvent): SessionFormatJsonObject
}

/** One caller-owned physical-row restore whose final value is a current logical artifact. */
export interface SessionFormatRestore {
  /** Current logical header available before body decoding. */
  readonly header: SessionFormatHeader
  /** Decode one physical row in file order. */
  decodeRow(rowValue: unknown): void
  /** Finish every decoder and migration stage and return the current artifact. */
  finish(): SessionFormatArtifact
}
