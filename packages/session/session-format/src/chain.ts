import { SessionFormatError, SessionFormatUnsupportedMigrationError } from './error.ts'
import {
  inspectSessionFormatVersion,
  snapshotSessionFormatArtifact,
  snapshotSessionFormatHeader,
  sessionFormatVersion,
} from './json.ts'
import type {
  SessionFormatArtifact,
  SessionFormatChain,
  SessionFormatChainOptions,
  SessionFormatHeader,
  SessionFormatMigration,
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
 * @returns immutable planner and whole-artifact runner.
 */
export function createSessionFormatChain(options: SessionFormatChainOptions): SessionFormatChain {
  return new CompiledSessionFormatChain(options)
}

class CompiledSessionFormatChain implements SessionFormatChain {
  readonly currentVersion: number
  private readonly migrations: readonly SessionFormatMigration[]
  private readonly restoreCurrent: SessionFormatChainOptions['restoreCurrent']
  private readonly restoreCurrentHeader: SessionFormatChainOptions['restoreCurrentHeader']

  constructor(options: SessionFormatChainOptions) {
    this.currentVersion = sessionFormatVersion(options.currentVersion, 'current Session format version')
    this.restoreCurrent = options.restoreCurrent
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

  plan(fromVersion: number): readonly SessionFormatMigration[] {
    const from = sessionFormatVersion(fromVersion, 'stored Session format version')
    if (from > this.currentVersion) {
      throw new SessionFormatUnsupportedMigrationError(
        `stored Session uses newer format v${from}; this build writes v${this.currentVersion}`,
      )
    }
    return Object.freeze(this.migrations.slice(from))
  }

  migrate(source: SessionFormatArtifact): SessionFormatArtifact {
    const storedVersion = inspectSessionFormatVersion(source.header)
    let current = snapshotSessionFormatArtifact(source, `format v${storedVersion} source`)
    if (storedVersion === this.currentVersion) {
      current = snapshotSessionFormatArtifact(this.restoreCurrent(current), 'current Session restoration')
      this.assertCurrent(current)
      return current
    }
    for (const migration of this.plan(storedVersion)) {
      let migrated: SessionFormatArtifact
      try {
        migrated = migration.migrate(snapshotSessionFormatArtifact(current, `${migration.name} input`))
      } catch (error: unknown) {
        throwUnsupportedRefusal(migration, error)
      }
      current = snapshotSessionFormatArtifact(migrated, `${migration.name} output`)
      if (current.header.version !== migration.toVersion) {
        throw new SessionFormatError(`${migration.name} returned v${current.header.version}; expected v${migration.toVersion}`)
      }
      try {
        migration.validateTarget(current)
      } catch (error: unknown) {
        throwUnsupportedRefusal(migration, error)
      }
    }
    current = snapshotSessionFormatArtifact(this.restoreCurrent(current), 'current Session restoration')
    this.assertCurrent(current)
    return current
  }

  migrateHeader(source: SessionFormatHeader): SessionFormatHeader {
    let current = snapshotSessionFormatHeader(source, 'stored Session header')
    for (const migration of this.plan(current.version)) {
      let migrated: SessionFormatHeader
      try {
        migrated = migration.migrateHeader(snapshotSessionFormatHeader(current, `${migration.name} header input`))
      } catch (error: unknown) {
        throwUnsupportedRefusal(migration, error, 'Session header')
      }
      current = snapshotSessionFormatHeader(migrated, `${migration.name} header output`)
      if (current.version !== migration.toVersion) {
        throw new SessionFormatError(`${migration.name} header returned v${current.version}; expected v${migration.toVersion}`)
      }
      try {
        migration.validateTargetHeader(current)
      } catch (error: unknown) {
        throwUnsupportedRefusal(migration, error, 'Session header')
      }
    }
    current = snapshotSessionFormatHeader(this.restoreCurrentHeader(current), 'current Session header restoration')
    if (current.version !== this.currentVersion) {
      throw new SessionFormatError(
        `current Session header restorer returned v${current.version}; expected v${this.currentVersion}`,
      )
    }
    return current
  }

  private assertCurrent(artifact: SessionFormatArtifact): void {
    if (artifact.header.version !== this.currentVersion) {
      throw new SessionFormatError(
        `current Session restorer returned v${artifact.header.version}; expected v${this.currentVersion}`,
      )
    }
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
