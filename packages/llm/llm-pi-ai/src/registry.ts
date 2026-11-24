/**
 * The provider routes that plugin rows add to one pi-ai adapter, beside the routes of the adapter row's own
 * `providers` dict.
 *
 * Several rows may name one route, and the dict may name it too, which is how a later composition layer
 * replaces a provider that an earlier layer configures. The declaration that comes last in the composed entry
 * list is in effect, and the dict takes the position of the adapter's row; the other declarations stay
 * registered and take over when that one is withdrawn.
 *
 * @module dsh-llm-pi-ai/registry
 */
import { FiberState, Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-app-boot'
import { resolveProfiles } from './config.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provider routes of the pi-ai adapter that plugin rows add; each provider row registers its route here. */
    piAiProviders: PiAiProviders
  }
}

/** One registered provider route. Calling it withdraws the registration. */
export interface PiAiProviderRegistration {
  (): void
  /**
   * Replace the profile of this registration, keeping its route and its place among the declarations of the
   * same route. A profile that cannot be applied throws and leaves the previous profile registered.
   * @param profile - the complete next profile.
   */
  replace(profile: PiAiProviderProfile): void
}

/** Service through which provider rows add their routes to the pi-ai adapter. */
export interface PiAiProviders {
  /**
   * Register one provider route for the calling plugin; the registration is withdrawn with that plugin.
   * @param provider - route key.
   * @param profile - the route's profile. Catalog defects are kept as diagnostics on the route; any other
   * invalid field throws.
   * @returns the registration handle.
   */
  register(provider: string, profile: PiAiProviderProfile): PiAiProviderRegistration
}

/** One route as the row in effect for it configures it. */
export interface PiAiRowRoute {
  /** The row's resolved profile. */
  profile: ResolvedPiAiProviderProfile
  /** Entry id of the row, which is the settings namespace of its form. Absent for a plugin mounted outside a Loader entry. */
  row?: string
}

/** The routes of the registered rows, on either side of the adapter's own row in the composed entry list. */
export interface PiAiRowRoutes {
  /** Routes of the rows that precede the adapter's row; an entry of its dict for the same route replaces them. */
  before: ReadonlyMap<string, PiAiRowRoute>
  /** Routes of the other rows, which replace an entry of the adapter row's dict for the same route. */
  after: ReadonlyMap<string, PiAiRowRoute>
}

/** One registration and the plugin that made it. */
interface Registration {
  provider: string
  /** What the adapter serves for this registration; a changed profile replaces the object. */
  route: PiAiRowRoute
  caller: Context
  /** Registration order, which decides between registrations at one position. */
  sequence: number
}

/** Position of a plugin's row in the composed entry list: its index in each enclosing list, outermost first. */
function position(caller: Context): number[] {
  const path: number[] = []
  for (let entry = caller.fiber.entry; entry !== undefined; entry = entry.parent.ctx.fiber.entry) {
    const { id } = entry.options
    path.unshift(entry.parent.data.findIndex(options => options.id === id))
  }
  return path
}

/** Order two positions as their rows appear in the composed entry list; a plugin outside any list comes first. */
function comparePositions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length && index < right.length; index++) {
    if (left[index] !== right[index]) return (left[index] as number) - (right[index] as number)
  }
  return left.length - right.length
}

function sameRoutes(left: ReadonlyMap<string, PiAiRowRoute>, right: ReadonlyMap<string, PiAiRowRoute>): boolean {
  const others = [...right]
  return left.size === right.size && [...left].every(([provider, route], index) =>
    others[index]?.[0] === provider && others[index][1] === route)
}

/**
 * Lay an adapter row's own dict between the rows that precede that row and the rows that follow it.
 * @param own - resolved profiles of the adapter row's dict.
 * @param rows - routes of the registered rows.
 * @returns the profile in effect for each route, and the entry id of the row that serves a route; a route that
 * the dict serves, or a plugin mounted outside a Loader entry, has no row.
 */
export function routesInEffect(own: ReadonlyMap<string, ResolvedPiAiProviderProfile>, rows: PiAiRowRoutes): {
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  rows: ReadonlyMap<string, string>
} {
  const profiles = new Map<string, ResolvedPiAiProviderProfile>()
  const ids = new Map<string, string>()
  const lay = (provider: string, profile: ResolvedPiAiProviderProfile, row: string | undefined): void => {
    profiles.set(provider, profile)
    if (row === undefined) ids.delete(provider)
    else ids.set(provider, row)
  }
  for (const [provider, route] of rows.before) lay(provider, route.profile, route.row)
  for (const [provider, profile] of own) lay(provider, profile, undefined)
  for (const [provider, route] of rows.after) lay(provider, route.profile, route.row)
  return { profiles, rows: ids }
}

function resolve(provider: string, profile: PiAiProviderProfile): ResolvedPiAiProviderProfile {
  return resolveProfiles({ [provider]: structuredClone(profile) }, 'deferred').get(provider) as ResolvedPiAiProviderProfile
}

/** Keeps every provider registration and publishes, per route, the row in effect on each side of its owner's row. */
export class PiAiProviderRegistry extends Service implements PiAiProviders {
  private readonly registrations = new Set<Registration>()
  private sequence = 0
  private published: PiAiRowRoutes = { before: new Map(), after: new Map() }

  /**
   * @param owner - the adapter plugin's context, which owns the service.
   * @param publish - applies the routes of the rows in effect to the adapter's routes and directory; called
   * only when they changed. A throw rejects the change that produced them and must leave the previously
   * published routes applied.
   */
  constructor(private readonly owner: Context, private readonly publish: (routes: PiAiRowRoutes) => void) {
    super(owner, 'piAiProviders')
    // A reconciled profile patch can move rows without restarting them, which changes the row in effect.
    owner.on('app-boot/config-reload', () => {
      try {
        this.commit()
      } catch (error) {
        owner.logger.error('llm-pi-ai: the provider rows in effect after a configuration reload could not be applied')
        owner.logger.error(error)
      }
    })
  }

  register(provider: string, profile: PiAiProviderProfile): PiAiProviderRegistration {
    const caller = this.ctx
    const row = caller.fiber.entry?.options.id
    const routeOf = (next: PiAiProviderProfile): PiAiRowRoute => ({ profile: resolve(provider, next), ...row === undefined ? {} : { row } })
    let registration: Registration | undefined
    const dispose = caller.effect(function* (this: PiAiProviderRegistry) {
      const added: Registration = { provider, route: routeOf(profile), caller, sequence: this.sequence++ }
      this.registrations.add(added)
      try {
        this.commit()
      } catch (error) {
        this.registrations.delete(added)
        throw error
      }
      registration = added
      yield () => {
        registration = undefined
        this.registrations.delete(added)
        // A stopping adapter releases its routes itself.
        if (this.owner.fiber.state === FiberState.ACTIVE) this.commit()
      }
    }.bind(this), 'piAiProviders.register()')
    const handle = (() => void dispose()) as PiAiProviderRegistration
    handle.replace = (next) => {
      if (registration === undefined) throw new Error('llm-pi-ai: a withdrawn provider registration cannot replace its profile')
      const current = registration
      const previous = current.route
      current.route = routeOf(next)
      try {
        this.commit()
      } catch (error) {
        current.route = previous
        throw error
      }
    }
    return handle
  }

  /**
   * Publish the routes of the rows in effect when a change to the registrations, or to the places of their rows,
   * changed them; the caller undoes a registration change whose publication throws.
   */
  private commit(): void {
    const owner = position(this.owner)
    const ordered = [...this.registrations]
      .map(registration => ({ registration, position: position(registration.caller) }))
      .sort((left, right) => comparePositions(left.position, right.position) || left.registration.sequence - right.registration.sequence)
    const before = new Map<string, PiAiRowRoute>()
    const after = new Map<string, PiAiRowRoute>()
    for (const { registration, position: place } of ordered) {
      const side = comparePositions(place, owner) < 0 ? before : after
      // The later declaration of a route takes the earlier one's place in the order as well as its profile.
      side.delete(registration.provider)
      side.set(registration.provider, registration.route)
    }
    if (sameRoutes(before, this.published.before) && sameRoutes(after, this.published.after)) return
    const previous = this.published
    this.published = { before, after }
    try {
      this.publish(this.published)
    } catch (error) {
      this.published = previous
      throw error
    }
  }
}
