/**
 * Pure types of the working-directory domain: the one home of the
 * `workingDirectory` projection-key declaration, free of this package's
 * host-side value imports. `./client` projects it to client aggregates.
 *
 * @module @deepseek-ai/dsh-working-directory/types
 */

// Marks this file a module so the declaration below augments the projection
// table instead of declaring an ambient module.
export {}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current directory for Session observations, or null when none is recorded. */
    workingDirectory: string | null
  }
}
