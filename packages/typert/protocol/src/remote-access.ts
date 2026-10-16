/**
 * Resources of Remote access control: the built-in identity-less `global`
 * resource and one resource per identity of a kind declared in
 * `TypertResourceMap`. Resources are independent: access to one resource
 * implies no access to any other.
 * @module @deepseek-ai/dsh-typert-protocol/remote-access
 */

/* oxlint-disable typescript/no-redundant-type-constituents --
 * `TypertResourceKind` is the declare-merge key pattern: the resource map is
 * empty in this compilation unit, so the rule sees `never`, while every
 * domain that declares a kind merges its key in. */
import type {
  TypertResourceId,
  TypertResourceKind,
  TypertResourceMap,
} from './types.ts'

/** One resource kind: the built-in `global` kind or a declared kind. */
export type RemoteAccessResourceKind = 'global' | TypertResourceKind

/**
 * One resource a call or forwarded event touches: `global`, or one identity
 * of a declared kind. Identities are wire values, read before any lookup
 * resolves or validates them.
 */
export type RemoteAccessResource =
  | { readonly kind: 'global' }
  | {
    [Kind in TypertResourceKind]: { readonly kind: Kind; readonly id: TypertResourceId<TypertResourceMap[Kind]> }
  }[TypertResourceKind]

/**
 * The resource variant of one kind: `{ kind: 'global' }` for `global`, else
 * that kind with its identity.
 * @template K - the resource kind to select.
 */
export type RemoteAccessResourceOf<K extends RemoteAccessResourceKind> = Extract<RemoteAccessResource, { readonly kind: K }>
