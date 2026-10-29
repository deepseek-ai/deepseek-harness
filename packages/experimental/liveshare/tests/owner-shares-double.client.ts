/**
 * Test-owned `liveshareShares` Remote namespace.
 *
 * The owner surfaces address every share-management call through the generated namespace, so a spec
 * scripts this face and reads the calls it recorded instead of stubbing `fetch`. A spec overrides
 * only the methods its case exercises; every other method resolves as an empty, accepted Host.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/tests/owner-shares-double
 */

import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { OwnerShares } from '../src/client/owner-shares.ts'
import type { ShareAccess } from '../src/share-api-types.ts'

/** Relay address the default location and identity answers name. */
export const DOUBLE_RELAY = 'https://relay.example.test'

/** ACL scope the default created share carries. */
export const OPEN_ACCESS: ShareAccess = {
  mode: 'open',
  selected: [],
  deploymentAllowedSubjectIds: [],
  shareAllowedSubjectIds: [],
  broadenedByDeploymentSubjects: false,
  identityKeyAcl: true,
}

/** One accepted Remote answer. */
export function accepted<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/**
 * One refused Remote answer carrying a Host code.
 * @param code - `liveshareShares/` failure the operation would throw.
 * @param details - structured payload the code declares.
 * @returns The error branch a Remote call resolves to.
 */
export function refused<Code extends RemoteErrorCode>(
  code: Code,
  details: RemoteErrorDetailsMap[Code],
): RemoteResult<never> {
  return { ok: false, error: new RemoteError(code, code, details) as RemoteFailure }
}

/** One call the double recorded. */
export interface OwnerSharesCall {
  /** Remote method the surface called. */
  readonly method: keyof OwnerShares
  /** Its one request argument, absent on the methods that take none. */
  readonly argument?: unknown
}

/** A scripted namespace plus the calls it recorded. */
export interface OwnerSharesDouble {
  /** The face the share surfaces receive. */
  readonly shares: OwnerShares
  /** Every call in order, which is what the request assertions read. */
  readonly calls: readonly OwnerSharesCall[]
}

/** Methods a spec may script; everything else keeps the accepted default. */
export type OwnerSharesOverrides = Partial<OwnerShares>

/**
 * Build one scripted namespace.
 * @param overrides - Methods this case scripts; the rest answer the accepted default.
 * @returns The namespace face and its recorded calls.
 */
export function ownerSharesDouble(overrides: OwnerSharesOverrides = {}): OwnerSharesDouble {
  const calls: OwnerSharesCall[] = []
  const base: OwnerShares = {
    create: async () => accepted({
      link: `${DOUBLE_RELAY}/?shareId=created`,
      shareId: 'created',
      sessionId: 'session',
      sessionMode: 'view',
      access: OPEN_ACCESS,
    }),
    list: async () => accepted({ shares: [] }),
    stop: async () => accepted({ ok: true }),
    updatePermissions: async request => accepted({
      shareId: request.shareId,
      sessionMode: request.sessionMode ?? 'view',
      allowsFork: request.allowsFork ?? false,
    }),
    setCapabilities: async request => accepted({
      shareId: request.shareId,
      viewerCapabilities: request.capabilities ?? [],
    }),
    capabilities: async () => accepted({ capabilities: [] }),
    relay: async () => accepted({ override: DOUBLE_RELAY, effective: DOUBLE_RELAY }),
    setRelay: async request => accepted({ override: request.relayUrl ?? DOUBLE_RELAY, effective: request.relayUrl ?? DOUBLE_RELAY }),
    identity: async () => accepted({ state: 'verified' as const, relay: DOUBLE_RELAY }),
    audit: async () => accepted({ events: [] }),
    testRelay: async () => accepted({ ok: true, httpReachable: true, blocking: false }),
    testPublish: async () => accepted({ ok: true, blocking: false }),
    ...overrides,
  }
  const record = <T>(method: keyof OwnerShares, argument: unknown, call: () => Promise<T>): Promise<T> => {
    calls.push(argument === undefined ? { method } : { method, argument })
    return call()
  }
  const shares: OwnerShares = {
    create: async request => record('create', request, () => base.create(request)),
    list: async () => record('list', undefined, () => base.list()),
    stop: async request => record('stop', request, () => base.stop(request)),
    updatePermissions: async request => record('updatePermissions', request, () => base.updatePermissions(request)),
    setCapabilities: async request => record('setCapabilities', request, () => base.setCapabilities(request)),
    capabilities: async () => record('capabilities', undefined, () => base.capabilities()),
    relay: async () => record('relay', undefined, () => base.relay()),
    setRelay: async request => record('setRelay', request, () => base.setRelay(request)),
    identity: async request => record('identity', request, () => base.identity(request)),
    audit: async request => record('audit', request, () => base.audit(request)),
    testRelay: async () => record('testRelay', undefined, () => base.testRelay()),
    testPublish: async request => record('testPublish', request, () => base.testPublish(request)),
  }
  return { shares, calls }
}

/**
 * Read one recorded call's request.
 * @param calls - Calls the double recorded.
 * @param method - Method whose request is read.
 * @returns The request, or undefined when the surface called no such method.
 */
export function requestOf<Method extends keyof OwnerShares>(
  calls: readonly OwnerSharesCall[],
  method: Method,
): Parameters<OwnerShares[Method]>[0] | undefined {
  const call = calls.find(entry => entry.method === method)
  return call?.argument as Parameters<OwnerShares[Method]>[0] | undefined
}
