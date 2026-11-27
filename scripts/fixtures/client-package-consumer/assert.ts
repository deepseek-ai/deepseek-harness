/** Type-level assertions shared by the external consumer fixtures; compiling a failed assertion is a type error. */

/** Resolves to `true` exactly when `A` and `B` are the same type. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

/** Accepts only `true`. */
export type Expect<T extends true> = T
