/** Definitions as specs send them in `run` requests to a daemon. */
import { createHash } from 'node:crypto'

/**
 * A definition with the hash that names it: the SHA-256 hex digest of the JSON encoding of `[source, methods]`.
 * @param source - function source.
 * @param methods - origin method names its runs expose.
 * @returns the `hash` and `definition` fields of a `run` request that carries its definition.
 */
export function shipped(source: string, methods: readonly string[] = []): {
  readonly hash: string
  readonly definition: { readonly source: string; readonly methods: readonly string[] }
} {
  return { hash: createHash('sha256').update(JSON.stringify([source, methods])).digest('hex'), definition: { source, methods } }
}
