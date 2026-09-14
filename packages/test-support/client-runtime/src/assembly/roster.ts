/**
 * Client roster: the ordered package-name rows a whole-client test boots, and
 * the plan that annotates one with the rows the test provides itself. `webApp`
 * and `bundleRoster` (`./bundle-roster.ts`) read rosters from the bundle patch
 * files; a spec may also build one inline with {@link ClientRoster.of}.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/roster
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { PLATFORM_MODULES } from '@deepseek-ai/dsh-client-web/src/platform.ts'

/** One browser plugin row as `dsh.client` declares it, keyed by package name. */
export interface ClientRosterRow {
  /** Package name (== manifest entry id == Loader entry name). */
  readonly name: string
  /** Package-name dependency edges from `dsh.client.inject` ([] when absent). */
  readonly inject: readonly string[]
  /** Stage-one prefetch mark from `dsh.client.immediately` (false when absent). */
  readonly immediately: boolean
}

/** Revision stamped on every synthesized row and batch; nothing is fetched by it. */
const LOCAL_REV = 'local'

/**
 * Synthesize the raw `WebBootGraph` for `rows`: one `application` batch
 * holding every row, `rev: 'local'`, placeholder `/plugins/<name>/client.js`
 * URLs, since every module is seeded in process and never fetched. Validation
 * stays with the production `parseBootManifest` inside the module system:
 * duplicate names and an empty roster are rejected there, not here.
 * @param rows - roster rows in composition order.
 * @returns the unparsed graph, as `createClientModuleSystem` consumes it.
 */
export function graphFromRoster(rows: readonly ClientRosterRow[]): WebBootGraph {
  const entries: WebBootEntry[] = rows.map(row => ({
    id: row.name,
    url: `/plugins/${row.name}/client.js`,
    rev: LOCAL_REV,
    ...(row.inject.length > 0 ? { inject: [...row.inject] } : {}),
    ...(row.immediately ? { immediately: true } : {}),
  }))
  return {
    rev: LOCAL_REV,
    entries,
    batches: [{
      phase: 'application',
      url: '/plugins/local.js',
      rev: LOCAL_REV,
      entries: entries.map(entry => entry.id),
    }],
  }
}

/** Module names the shell seeds before any row loads; an inject edge to one of them is satisfied without a row. */
const PLATFORM_SEED: ReadonlySet<string> = new Set(PLATFORM_MODULES)

/** Immutable, name-addressable roster. */
export class ClientRoster {
  /**
   * Build a roster from rows; duplicate names throw.
   * @param rows - roster rows in composition order.
   * @returns roster.
   */
  static of(rows: readonly ClientRosterRow[]): ClientRoster {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const { name } of rows) {
      if (seen.has(name)) duplicates.add(name)
      seen.add(name)
    }
    if (duplicates.size > 0) {
      throw new Error(`client-test-runtime: duplicate roster rows: ${[...duplicates].join(', ')}`)
    }
    return new ClientRoster(Object.freeze([...rows]))
  }

  private constructor(readonly rows: readonly ClientRosterRow[]) {}

  /**
   * Keep only `names`, preserving roster order; an unknown name throws with the roster listed.
   * @param names - package names to keep.
   * @returns sub-roster.
   */
  pick(names: readonly string[]): ClientRoster {
    const keep = this.known(names, 'pick')
    return new ClientRoster(Object.freeze(this.rows.filter(row => keep.has(row.name))))
  }

  /**
   * The named rows plus every row they inject, transitively, in roster order: the rows a spec needs to boot the
   * named plugins as the bundle composes them. The shell's platform modules (`PLATFORM_MODULES`, seeded statically
   * rather than loaded as rows) end the walk. An unknown name throws with the roster listed; a row injecting any
   * other package outside the roster throws, since the bundle itself would not boot.
   * @param names - package names whose dependency cone to keep.
   * @returns sub-roster.
   */
  closure(names: readonly string[]): ClientRoster {
    this.known(names, 'closure')
    const byName = new Map(this.rows.map(row => [row.name, row]))
    const keep = new Set<string>()
    const visit = (name: string, from: string | undefined): void => {
      if (keep.has(name) || PLATFORM_SEED.has(name)) return
      const row = byName.get(name)
      if (row === undefined) {
        throw new Error(`client-test-runtime: ${String(from)} injects ${name}, which is outside the roster`)
      }
      keep.add(name)
      for (const dependency of row.inject) visit(dependency, name)
    }
    for (const name of names) visit(name, undefined)
    return new ClientRoster(Object.freeze(this.rows.filter(row => keep.has(row.name))))
  }

  /**
   * Drop `names`; an unknown name throws with the roster listed.
   * @param names - package names to drop.
   * @returns sub-roster.
   */
  without(names: readonly string[]): ClientRoster {
    const drop = this.known(names, 'without')
    return new ClientRoster(Object.freeze(this.rows.filter(row => !drop.has(row.name))))
  }

  private known(names: readonly string[], operation: string): ReadonlySet<string> {
    const rostered = this.rows.map(row => row.name)
    const unknown = names.filter(name => !rostered.includes(name))
    if (unknown.length > 0) {
      throw new Error(
        `client-test-runtime: ${operation}() names outside the roster: ${unknown.join(', ')}; roster: ${rostered.join(', ')}`,
      )
    }
    return new Set(names)
  }
}

/** The module face the Loader materializes for one client plugin row. */
export interface ClientPluginModule {
  apply(ctx: Context, config?: unknown): unknown
  readonly inject?: readonly string[] | Readonly<Record<string, unknown>>
  readonly Config?: unknown
}

/** What to boot and what the test supplies itself. */
export interface AssemblyPlan {
  readonly roster: ClientRoster
  /** Row replacements by package name (the test's own implementation of that row). Names outside the roster throw. */
  readonly provide?: Readonly<Record<string, ClientPluginModule>>
}

/**
 * Validate a plan against its roster.
 * @param plan - plan to check.
 * @throws {Error} naming any `provide` key outside the roster.
 */
export function assertPlan(plan: AssemblyPlan): void {
  const rostered = plan.roster.rows.map(row => row.name)
  const unknown = Object.keys(plan.provide ?? {}).filter(name => !rostered.includes(name))
  if (unknown.length > 0) {
    throw new Error(
      `client-test-runtime: provide names rows outside the roster: ${unknown.join(', ')}; roster: ${rostered.join(', ')}`,
    )
  }
}
