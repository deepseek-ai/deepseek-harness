/**
 * React-free Client access state: the latest `remoteAccess/follow` snapshot
 * and identity-stable boolean sources per resource and action.
 * @module @deepseek-ai/dsh-api-remote-access/src/client/state
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteAccessFrame, RemoteAccessGrant, RemoteAccessResource } from '../types.ts'

/** Actions allowed per resource identity, for one declared resource kind. */
type KindGrants = ReadonlyMap<string, ReadonlySet<string>>

type AccessSnapshot =
  /** No baseline, or a non-owner snapshot stream failed: every answer is false. */
  | { readonly kind: 'closed' }
  | { readonly kind: 'owner' }
  | {
    readonly kind: 'granted'
    readonly global: ReadonlySet<string>
    readonly resources: ReadonlyMap<string, KindGrants>
  }

type GrantedSnapshot = Extract<AccessSnapshot, { kind: 'granted' }>

const CLOSED: AccessSnapshot = Object.freeze({ kind: 'closed' })
const OWNER_SNAPSHOT: AccessSnapshot = Object.freeze({ kind: 'owner' })
const GLOBAL_KEY = '\u0000global'

/** The opening frame of a snapshot generation. */
export type Baseline = Extract<RemoteAccessFrame, { type: 'baseline' }>

/**
 * Validate the opening baseline an index injection row assigned to the page.
 * @param value - the injected global; `undefined` when the page carries none.
 * @returns the baseline, or `undefined` when none was injected.
 * @throws TypeError when the injected value is not a baseline frame.
 */
export function parseInjectedBaseline(value: unknown): Baseline | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value['type'] !== 'baseline') throw new TypeError('remote access: the injected access snapshot is not a baseline frame')
  if (value['owner'] === true) return { type: 'baseline', owner: true }
  const grants = value['grants']
  if (value['owner'] !== false || !Array.isArray(grants) || !grants.every(isGrant)) {
    throw new TypeError('remote access: the injected access snapshot carries malformed grants')
  }
  return { type: 'baseline', owner: false, grants }
}

function isGrant(value: unknown): value is RemoteAccessGrant {
  if (!isRecord(value) || !isResource(value['resource'])) return false
  const actions = value['actions']
  return Array.isArray(actions) && actions.every(action => typeof action === 'string')
}

function isResource(value: unknown): value is RemoteAccessResource {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return false
  return value['kind'] === 'global' || typeof value['id'] === 'string'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Snapshot owner for one Client generation. Sources are cached per
 * `(kind, id, action)` so Hook bindings keep their identity; each source
 * computes its boolean from the current snapshot.
 */
export class ClientAccessState {
  private snapshot: AccessSnapshot = CLOSED

  /** @param initial - the page's injected opening baseline; without one every answer is false until a baseline arrives. */
  constructor(initial?: Baseline) {
    if (initial !== undefined) this.replace(initial)
  }
  private readonly listeners = new Set<() => void>()
  private readonly sources = new Map<string, HostObservable<boolean>>()

  /**
   * Answer for one action on the global resource.
   * @param action - endpoint action the caller may invoke.
   * @returns identity-stable boolean source.
   */
  global(action: string): HostObservable<boolean> {
    return this.cached(GLOBAL_KEY, '', action)
  }

  /**
   * Answer for one action on one resource of a declared kind.
   * @param kind - declared resource kind.
   * @param id - resource identity.
   * @param action - endpoint action the caller may invoke.
   * @returns identity-stable boolean source.
   */
  resource(kind: string, id: string, action: string): HostObservable<boolean> {
    return this.cached(kind, id, action)
  }

  /**
   * Replace the snapshot from one generation's opening frame.
   * @param frame - owner or non-owner baseline.
   */
  replace(frame: Baseline): void {
    if (frame.owner) {
      this.publish(OWNER_SNAPSHOT)
      return
    }
    let global: ReadonlySet<string> = new Set()
    const resources = new Map<string, Map<string, ReadonlySet<string>>>()
    // The baseline is unpublished, so its maps are filled in place.
    for (const { resource, actions } of frame.grants) {
      if (resource.kind === 'global') {
        global = new Set(actions)
        continue
      }
      let grants = resources.get(resource.kind)
      if (grants === undefined) {
        grants = new Map()
        resources.set(resource.kind, grants)
      }
      grants.set(resource.id, new Set(actions))
    }
    this.publish({ kind: 'granted', global, resources })
  }

  /**
   * Apply one increment of the current generation.
   * @param frame - `upsert` or `remove`.
   */
  update(frame: Exclude<RemoteAccessFrame, { type: 'baseline' }>): void {
    const current = this.snapshot
    if (current.kind !== 'granted') return
    switch (frame.type) {
      case 'upsert':
        this.publish(withGrant(current, frame.grant))
        return
      case 'remove':
        this.publish(withGrant(current, { resource: frame.resource, actions: [] }, true))
        return
      /* v8 ignore next -- the generated Remote codec validates this closed union. */
      default:
        return assertNever(frame)
    }
  }

  /** Whether the current snapshot is the owner's, whose answers never depend on the stream. */
  get owner(): boolean {
    return this.snapshot.kind === 'owner'
  }

  /** The stream failed terminally: the owner keeps every answer; a non-owner's answers become false. */
  unavailable(): void {
    if (this.snapshot.kind !== 'owner') this.publish(CLOSED)
  }

  private cached(kind: string, id: string, action: string): HostObservable<boolean> {
    const key = `${kind}\u0000${id}\u0000${action}`
    let source = this.sources.get(key)
    if (source === undefined) {
      source = {
        getSnapshot: () => answer(this.snapshot, kind, id, action),
        subscribe: (listener) => {
          this.listeners.add(listener)
          return () => { this.listeners.delete(listener) }
        },
      }
      this.sources.set(key, source)
    }
    return source
  }

  private publish(next: AccessSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

function answer(snapshot: AccessSnapshot, kind: string, id: string, action: string): boolean {
  switch (snapshot.kind) {
    case 'closed':
      return false
    case 'owner':
      return true
    case 'granted': {
      const allowed = kind === GLOBAL_KEY ? snapshot.global : snapshot.resources.get(kind)?.get(id)
      return allowed?.has(action) ?? false
    }
    /* v8 ignore next -- closed union. */
    default:
      return assertNever(snapshot)
  }
}

function withGrant(snapshot: GrantedSnapshot, grant: RemoteAccessGrant, remove = false): GrantedSnapshot {
  const resource = grant.resource
  if (resource.kind === 'global') return { ...snapshot, global: new Set(grant.actions) }
  const resources = new Map(snapshot.resources)
  const grants = new Map(resources.get(resource.kind))
  if (remove) grants.delete(resource.id)
  else grants.set(resource.id, new Set(grant.actions))
  resources.set(resource.kind, grants)
  return { ...snapshot, resources }
}

/* v8 ignore next 3 -- closed-union backstop. */
function assertNever(value: never): never {
  throw new Error(`unreachable access frame: ${JSON.stringify(value)}`)
}
