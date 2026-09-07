import { SessionFormatError, SessionFormatUnsupportedMigrationError } from './error.ts'
import {
  snapshotSessionFormatHeader,
  sessionFormatCount,
  sessionFormatVersion,
} from './json.ts'
import type {
  SessionFormatChain,
  SessionFormatChainOptions,
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatHeader,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStream,
} from './types.ts'

/**
 * Validate and freeze one adjacent migration declaration.
 * @param migration - named exact adjacent conversion.
 * @returns immutable validated declaration.
 */
export function defineSessionFormatMigration(migration: SessionFormatMigration): SessionFormatMigration {
  if (typeof migration.name !== 'string' || migration.name.length === 0) {
    throw new SessionFormatError('Session migration name must be a non-empty string')
  }
  const from = sessionFormatVersion(migration.fromVersion, `${migration.name} fromVersion`)
  const to = sessionFormatVersion(migration.toVersion, `${migration.name} toVersion`)
  if (to !== from + 1) {
    throw new SessionFormatError(`${migration.name} must declare adjacent v${from}->v${from + 1}`)
  }
  return Object.freeze({ ...migration })
}

/**
 * Compile a unique, complete adjacent migration chain.
 * @param options - current version, adjacent declarations, and current restorer.
 * @returns immutable planner and streaming migration compiler.
 */
export function createSessionFormatChain(options: SessionFormatChainOptions): SessionFormatChain {
  return new CompiledSessionFormatChain(options)
}

class CompiledSessionFormatChain implements SessionFormatChain {
  readonly currentVersion: number
  private readonly migrations: readonly SessionFormatMigration[]
  private readonly restoreCurrentHeader: SessionFormatChainOptions['restoreCurrentHeader']

  constructor(options: SessionFormatChainOptions) {
    this.currentVersion = sessionFormatVersion(options.currentVersion, 'current Session format version')
    this.restoreCurrentHeader = options.restoreCurrentHeader
    const byFrom = new Map<number, SessionFormatMigration>()
    const names = new Set<string>()
    for (const candidate of options.migrations) {
      const migration = defineSessionFormatMigration(candidate)
      if (byFrom.has(migration.fromVersion)) {
        throw new SessionFormatError(`Session migration v${migration.fromVersion}->v${migration.toVersion} is duplicated`)
      }
      if (names.has(migration.name)) throw new SessionFormatError(`Session migration name ${JSON.stringify(migration.name)} is duplicated`)
      byFrom.set(migration.fromVersion, migration)
      names.add(migration.name)
    }
    const ordered: SessionFormatMigration[] = []
    for (let version = 0; version < this.currentVersion; version += 1) {
      const migration = byFrom.get(version)
      if (migration === undefined) {
        throw new SessionFormatUnsupportedMigrationError(`Session migration v${version}->v${version + 1} is missing`)
      }
      ordered.push(migration)
    }
    if (byFrom.size !== ordered.length) {
      const invalid = [...byFrom.keys()].find(version => version >= this.currentVersion) as number
      throw new SessionFormatError(`Session migration from v${invalid} does not lead to current v${this.currentVersion}`)
    }
    this.migrations = Object.freeze(ordered)
  }

  private plan(fromVersion: number): readonly SessionFormatMigration[] {
    const from = sessionFormatVersion(fromVersion, 'stored Session format version')
    if (from > this.currentVersion) {
      throw new SessionFormatUnsupportedMigrationError(
        `stored Session uses newer format v${from}; this build writes v${this.currentVersion}`,
      )
    }
    return Object.freeze(this.migrations.slice(from))
  }

  createStream(
    sourceHeader: SessionFormatHeader,
    sourceCut: number,
    output: SessionFormatMigrationContext,
  ): SessionFormatMigrationStream {
    let header = sourceHeader
    const validatedSourceCut = sessionFormatCount(sourceCut, 'Session inherited event count')
    let inheritedEventCount = validatedSourceCut
    const stages: Array<{
      readonly migration: SessionFormatMigration
      readonly stage: SessionFormatMigrationStage
    }> = []
    const plan = this.plan(header.version)
    for (const [index, migration] of plan.entries()) {
      const targetHeader = this.advanceHeader(migration, header)
      let stage: SessionFormatMigrationStage
      try {
        stage = migration.createStage({
          sourceHeader: header,
          targetHeader,
          sourceInheritedEventCount: inheritedEventCount,
          sourceKind: index === 0 ? 'decoded' : 'transformed',
        })
      } catch (error: unknown) {
        throwUnsupportedRefusal(migration, error)
      }
      header = targetHeader
      stages.push({ migration, stage })
      if (index + 1 < plan.length) {
        const targetCut = stage.headerInheritedEventCount
        if (targetCut === undefined) {
          throw new SessionFormatError(`${migration.name} must expose its inherited cut before the next migration`)
        }
        inheritedEventCount = targetCut
      }
    }
    return new CompiledSessionFormatMigrationStream(
      header,
      validatedSourceCut,
      stages,
      output,
    )
  }

  migrateHeader(source: SessionFormatHeader): SessionFormatHeader {
    let current = snapshotSessionFormatHeader(source, 'stored Session header')
    for (const migration of this.plan(current.version)) {
      current = this.advanceHeader(migration, current)
    }
    current = snapshotSessionFormatHeader(this.restoreCurrentHeader(current), 'current Session header restoration')
    if (current.version !== this.currentVersion) {
      throw new SessionFormatError(
        `current Session header restorer returned v${current.version}; expected v${this.currentVersion}`,
      )
    }
    return current
  }

  private advanceHeader(
    migration: SessionFormatMigration,
    source: SessionFormatHeader,
  ): SessionFormatHeader {
    let target: SessionFormatHeader
    try {
      target = migration.migrateHeader(snapshotSessionFormatHeader(source, `${migration.name} header input`))
    } catch (error: unknown) {
      throwUnsupportedRefusal(migration, error, 'Session header')
    }
    const current = snapshotSessionFormatHeader(target, `${migration.name} header output`)
    if (current.version !== migration.toVersion) {
      throw new SessionFormatError(`${migration.name} header returned v${current.version}; expected v${migration.toVersion}`)
    }
    try {
      migration.validateTargetHeader(current)
    } catch (error: unknown) {
      throwUnsupportedRefusal(migration, error, 'Session header')
    }
    return current
  }
}

interface CompiledMigrationStage {
  readonly migration: SessionFormatMigration
  readonly stage: SessionFormatMigrationStage
}

class ChainedMigrationContext implements SessionFormatMigrationContext {
  constructor(
    private readonly entry: CompiledMigrationStage,
    private readonly output: SessionFormatMigrationContext,
  ) {}

  emitEvent(event: SessionFormatEvent): void {
    try {
      this.entry.stage.transformEvent(event, this.output)
    } catch (error: unknown) {
      throwUnsupportedRefusal(this.entry.migration, error)
    }
  }

  emitRun(run: SessionFormatEventRun): void {
    try {
      this.entry.stage.transformRun(run, this.output)
    } catch (error: unknown) {
      throwUnsupportedRefusal(this.entry.migration, error)
    }
  }

  finish(): number {
    let targetCut: number
    try {
      targetCut = this.entry.stage.finish(this.output)
    } catch (error: unknown) {
      throwUnsupportedRefusal(this.entry.migration, error)
    }
    if (this.entry.stage.headerInheritedEventCount !== undefined
      && this.entry.stage.headerInheritedEventCount !== targetCut) {
      throw new SessionFormatError(`${this.entry.migration.name} changed its predeclared inherited cut`)
    }
    return targetCut
  }
}

class CompiledSessionFormatMigrationStream implements SessionFormatMigrationStream {
  private readonly input: SessionFormatMigrationContext
  private readonly stages: readonly ChainedMigrationContext[]

  constructor(
    readonly header: SessionFormatHeader,
    private readonly sourceInheritedEventCount: number,
    entries: readonly CompiledMigrationStage[],
    output: SessionFormatMigrationContext,
  ) {
    const stages = new Array<ChainedMigrationContext>(entries.length)
    let downstream = output
    for (const [offset, entry] of entries.toReversed().entries()) {
      const context = new ChainedMigrationContext(entry, downstream)
      stages[entries.length - offset - 1] = context
      downstream = context
    }
    this.input = downstream
    this.stages = stages
  }

  emitEvent(event: SessionFormatEvent): void {
    this.input.emitEvent(event)
  }

  emitRun(run: SessionFormatEventRun): void {
    this.input.emitRun(run)
  }

  finish(): number {
    let inheritedEventCount = this.sourceInheritedEventCount
    for (const stage of this.stages) inheritedEventCount = stage.finish()
    return inheritedEventCount
  }
}

function throwUnsupportedRefusal(
  migration: SessionFormatMigration,
  error: unknown,
  subject = 'Session',
): never {
  if (error instanceof SessionFormatUnsupportedMigrationError) throw error
  const detail = error instanceof Error ? error.message : String(error)
  throw new SessionFormatUnsupportedMigrationError(
    `${migration.name} refuses this format v${migration.fromVersion} ${subject}: ${detail}`,
    { cause: error },
  )
}
