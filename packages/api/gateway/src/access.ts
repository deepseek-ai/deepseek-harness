/**
 * Resource resolution for non-owner access decisions: the resources one call
 * or one forwarded event touches, read from Typert-validated arguments before
 * any lookup or Context resolves them.
 * @module @deepseek-ai/dsh-api-gateway/src/access
 */

import type {
  InvocationDescriptor,
  RemoteAccessResource,
  TypertRegistryContract,
  TypertResourceReader,
} from '@deepseek-ai/dsh-typert-protocol'

const GLOBAL: readonly RemoteAccessResource[] = Object.freeze([Object.freeze({ kind: 'global' })])

/** Resource ids one source produced for a kind, or `invalid` for a malformed value. */
type ResourceIds = readonly unknown[] | 'invalid'

/**
 * Resolve the resources one call touches. For each resource kind, a
 * `resources` reader of the method wins; otherwise every lookup parameter
 * whose provider declares the kind contributes its wire resource id, and so
 * does the Context identity of a Context method whose Host adapter declares
 * the kind; otherwise the kind's default field registered in
 * `typert.resources` is read from a top-level argument or, failing that,
 * from the first object argument.
 * @param typert - registry holding default fields, lookup providers, and Host Context adapters.
 * @param readers - the method's `resources` readers, or `undefined` when it declares none.
 * @param descriptor - receiver, parameter order, lookups, and cancellation slot of the method.
 * @param args - named arguments matched to the descriptor's field set: JSON
 *   arguments as their Typert codecs validated them, lookup and Context
 *   identities as wire values.
 * @param signal - value placed in the cancellation slot of the positional arguments.
 * @returns the touched resources, the global resource alone when none;
 *   `undefined` when the resources are invalid: a reader throws or returns
 *   an empty list, a default field holds an array, or a resource id is not a
 *   non-empty string.
 */
export function callResources(
  typert: Pick<TypertRegistryContract, 'contexts' | 'lookups' | 'resources'>,
  readers: Readonly<Record<string, TypertResourceReader>> | undefined,
  descriptor: Pick<InvocationDescriptor, 'cancellation' | 'invocation' | 'parameters'>,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): readonly RemoteAccessResource[] | undefined {
  // Each later source replaces an earlier one for its kind and keeps the kind's position.
  const sources = new Map<string, () => ResourceIds>()
  for (const { kind, field } of typert.resources.entries()) {
    sources.set(kind, () => {
      // A default field names exactly one resource id; only a reader may return several.
      const id = defaultFieldId(descriptor, args, field)
      return Array.isArray(id) ? 'invalid' : id === undefined ? [] : [id]
    })
  }
  for (const [kind, ids] of lookupResources(typert, descriptor, args)) {
    sources.set(kind, () => ids)
  }
  let positional: readonly unknown[] | undefined
  for (const [kind, reader] of Object.entries(readers ?? {})) {
    sources.set(kind, () => {
      positional ??= [
        ...descriptor.parameters.map(parameter => args[parameter.wire]),
        ...descriptor.cancellation === undefined ? [] : [signal],
      ]
      return read(reader, positional, [])
    })
  }
  const resources: RemoteAccessResource[] = []
  for (const [kind, ids] of sources) {
    if (!collect(resources, kind, ids())) return undefined
  }
  return resources.length === 0 ? GLOBAL : resources
}

/**
 * Resolve the resources one forwarded event notification touches. An event
 * carries every resource it declares, so a reader returning `undefined`
 * makes the notification invalid instead of a global one.
 * @param readers - the event entry's declared readers, or `undefined` when it declares none.
 * @param args - the event's validated JSON arguments, passed to each reader as its positional arguments.
 * @returns the global resource alone without readers, including an empty
 *   reader set; otherwise the touched resources; `undefined` when the
 *   resources are invalid: a resource id is missing or malformed.
 */
export function eventResources(
  readers: Readonly<Record<string, TypertResourceReader>> | undefined,
  args: readonly unknown[],
): readonly RemoteAccessResource[] | undefined {
  const declared = Object.entries(readers ?? {})
  if (declared.length === 0) return GLOBAL
  const resources: RemoteAccessResource[] = []
  for (const [kind, reader] of declared) {
    if (!collect(resources, kind, read(reader, args, 'invalid'))) return undefined
  }
  return resources
}

/**
 * The resource ids lookup parameters and the Context identity name, per
 * resource kind: the Context identity first, then lookup parameters in order.
 * An optional lookup parameter the call omits names no resource id; the
 * Context identity is required.
 */
function lookupResources(
  typert: Pick<TypertRegistryContract, 'contexts' | 'lookups'>,
  descriptor: Pick<InvocationDescriptor, 'invocation' | 'parameters'>,
  args: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, unknown[]> {
  const ids = new Map<string, unknown[]>()
  const add = (kind: string, id: unknown): void => {
    const list = ids.get(kind)
    if (list === undefined) ids.set(kind, [id])
    else list.push(id)
  }
  const receiver = descriptor.invocation
  if (receiver.kind === 'context') {
    const kind = typert.contexts.getHost(receiver.context)?.resource
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- domain packages merge resource kinds into TypertResourceMap.
    if (kind !== undefined) add(kind, args[receiver.wire])
  }
  for (const parameter of descriptor.parameters) {
    if (parameter.lookup === undefined) continue
    const kind = typert.lookups.get(parameter.lookup)?.resource
    const id = args[parameter.wire]
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- domain packages merge resource kinds into TypertResourceMap.
    if (kind !== undefined && id !== undefined) add(kind, id)
  }
  return ids
}

/** Run one reader with spread positional arguments: `undefined` yields `absent`, a list names several and must not be empty. */
function read(reader: TypertResourceReader, args: readonly unknown[], absent: ResourceIds): ResourceIds {
  let value: unknown
  try {
    value = reader(...args)
  } catch {
    // Any reader error means it cannot name its resources, so they are invalid.
    return 'invalid'
  }
  if (value === undefined) return absent
  if (!Array.isArray(value)) return [value]
  return value.length === 0 ? 'invalid' : value
}

/** Append one kind's resource ids; false when any is malformed. */
function collect(resources: RemoteAccessResource[], kind: string, ids: ResourceIds): boolean {
  if (ids === 'invalid') return false
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return false
    // Kinds come from registrations, lookups, Context adapters, and reader keys, all typed by the merged resource map.
    resources.push({ kind, id } as RemoteAccessResource)
  }
  return true
}

/** The default field: a top-level argument, else that field of the first object argument. */
function defaultFieldId(
  descriptor: Pick<InvocationDescriptor, 'parameters'>,
  args: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  if (descriptor.parameters.some(parameter => parameter.wire === field)) return args[field]
  for (const parameter of descriptor.parameters) {
    const value = args[parameter.wire]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    if (!Object.hasOwn(value, field)) return undefined
    const id: unknown = Reflect.get(value, field)
    return id
  }
  return undefined
}
