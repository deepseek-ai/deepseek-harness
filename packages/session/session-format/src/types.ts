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

/** One independently maintained adjacent whole-artifact migration. */
export interface SessionFormatMigration {
  readonly name: string
  readonly fromVersion: number
  readonly toVersion: number
  /** Convert one header without reading event bodies. */
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
  /** Convert one detached complete artifact to exactly {@link toVersion}. */
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
  /** Refuse any artifact that the adjacent target writer cannot emit. */
  validateTarget(artifact: SessionFormatArtifact): void
  /** Refuse any header that the adjacent target writer cannot emit. */
  validateTargetHeader(header: SessionFormatHeader): void
}

/** Inputs that compile the unique complete migration chain. */
export interface SessionFormatChainOptions {
  readonly currentVersion: number
  readonly migrations: readonly SessionFormatMigration[]
  /** Restore and validate a detached current artifact through the current parser. */
  readonly restoreCurrent: (artifact: SessionFormatArtifact) => SessionFormatArtifact
  /** Restore and validate a detached current header without reading event bodies. */
  readonly restoreCurrentHeader: (header: SessionFormatHeader) => SessionFormatHeader
}

/** Pure adjacent planner and whole-artifact migration runner. */
export interface SessionFormatChain {
  readonly currentVersion: number
  /** Return the complete ordered plan from one supported stored version. */
  plan(fromVersion: number): readonly SessionFormatMigration[]
  /** Restore current input directly or migrate old input entirely in memory. */
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
  /** Convert only a supported header to the current logical representation. */
  migrateHeader(header: SessionFormatHeader): SessionFormatHeader
}

/** Physical JSON records emitted by one format-specific codec. */
export interface EncodedSessionFormatArtifact {
  readonly header: SessionFormatJsonObject
  readonly rows: readonly SessionFormatJsonObject[]
}

/** Options that affect only physical row layout, never logical contents. */
export interface SessionFormatEncodeOptions {
  readonly packChunks: boolean
}

/** Pure physical JSON codec frozen with one released Session format. */
export interface SessionFormatCodec {
  readonly version: number
  /** Decode one physical header into body-independent logical metadata. */
  decodeHeader(value: unknown): SessionFormatHeader
  /** Decode one complete physical header and row sequence into logical events. */
  decodeArtifact(headerValue: unknown, rowValues: readonly unknown[]): SessionFormatArtifact
  /** Decode the row-atomic recoverable prefix used by crash-tail repair. */
  decodeRecoverableArtifact(
    headerValue: unknown,
    rowValues: readonly unknown[],
  ): SessionFormatArtifact
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
  /** Encode one already-restored current artifact through its format-specific writer. */
  readonly encodeCurrentArtifact: (artifact: SessionFormatArtifact) => EncodedSessionFormatArtifact
}

/** Build-static physical dispatch and adjacent migration catalog. */
export interface SessionFormatCatalog {
  readonly currentVersion: number
  /** Classify and translate one header without reading event rows. */
  readHeader(headerValue: unknown): SessionFormatHeaderReadResult
  /** Dispatch a complete physical JSON artifact through its frozen version codec. */
  decodeArtifact(headerValue: unknown, rowValues: readonly unknown[]): SessionFormatArtifact
  /** Dispatch a physical artifact through its released row-prefix recovery rules. */
  decodeRecoverableArtifact(
    headerValue: unknown,
    rowValues: readonly unknown[],
  ): SessionFormatArtifact
  /** Restore current input directly or run all required adjacent migrations in memory. */
  migrate(artifact: SessionFormatArtifact): SessionFormatArtifact
  /** Encode one current artifact that `migrate` returned or a live Session produced; it is not re-validated here. */
  encodeCurrent(artifact: SessionFormatArtifact): EncodedSessionFormatArtifact
}
