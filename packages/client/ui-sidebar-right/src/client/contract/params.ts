/**
 * Navigation parameters, typed by what is being opened.
 *
 * Two declaration-merged maps. `SidebarRightResourceParamsMap` is keyed by
 * resource type — the segment after `dsh-resource://` — and filled by the
 * package that owns that type (the `file` provider adds `file: { line?: number }`);
 * `SidebarRightTabParamsMap` is keyed by tab kind and filled by a page type that
 * takes parameters (neither shipped page does). Values are JSON-shaped by
 * convention; nothing validates them at run time, because caller and body meet
 * at a typed same-process boundary. A body narrows `navigation.params` by the
 * scheme and type of `navigation.address`.
 *
 * The unions below are spelled as indexed accesses over a record rather than as
 * `A | B`: in a program where no package has augmented a map, both sides of such
 * a union resolve to `undefined`, which the type-aware lint reads as a duplicated
 * constituent. The indexed access names the same union without the pair.
 */

/** The values of a record, as one union. */
type ValuesOf<T> = T[keyof T]

/** Resource type → the parameters a resource of that type accepts. Merge-extensible. */
export interface SidebarRightResourceParamsMap {}

/** What `openResource` accepts as `params`: a declared resource type's parameters, or `undefined` for none. */
export type SidebarRightResourceParams = ValuesOf<{
  declared: SidebarRightResourceParamsMap[keyof SidebarRightResourceParamsMap]
  none: undefined
}>

/** Tab kind → the parameters a page of that kind accepts. Merge-extensible. */
export interface SidebarRightTabParamsMap {}

/**
 * What `openTab(kind)` accepts as `params` for one kind: its declared parameters,
 * or `undefined` for none; a kind that declares none accepts only `undefined`.
 */
export type SidebarRightTabParamsFor<K extends string> =
  | (K extends keyof SidebarRightTabParamsMap ? SidebarRightTabParamsMap[K] : never)
  | undefined

/** Every declared page kind's parameters, or `undefined` for none. */
export type SidebarRightTabParams = ValuesOf<{
  declared: SidebarRightTabParamsMap[keyof SidebarRightTabParamsMap]
  none: undefined
}>

/** What a body may find in `navigation.params`: either map's values, or `undefined` when the opener gave none. */
export type SidebarRightNavigationParams = ValuesOf<{
  resource: SidebarRightResourceParams
  tab: SidebarRightTabParams
}>
