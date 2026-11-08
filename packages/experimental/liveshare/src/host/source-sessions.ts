/**
 * The source-Session list shared by share records and fork state.
 *
 * A share carries one or more source Sessions, primary first. Code that needs the single Session a
 * wire field or a page target names reads {@link primarySessionIdOf} instead of keeping a second copy
 * of that id on the record.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/source-sessions
 */

/** Anything that carries a share's source Session ids, primary first. */
export interface SourceSessionIds {
  readonly sessionIds: readonly string[]
}

/**
 * Read the primary source Session of a share.
 * @param share - Record whose source list is nonempty.
 * @returns The first source Session id.
 */
export function primarySessionIdOf(share: SourceSessionIds): string {
  const [primary] = share.sessionIds
  /* v8 ignore next 3 -- every stored and constructed share carries at least one source. */
  if (primary === undefined) {
    throw new Error('a share must carry at least one source Session')
  }
  return primary
}
