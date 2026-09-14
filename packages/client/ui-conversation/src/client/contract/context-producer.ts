/** Shared types for target-owned context-source projections. */

/**
 * Which model-facing role a logged non-user message plays.
 *
 * `recall` marks material lifted out of another session's log; `inject` marks
 * every other producer-supplied context. Mid-turn steering is the third role
 * the transcript distinguishes, but it has its own event and node kind
 * (`steering/message` / `SteeringMessageNode`) and never reaches here.
 */
export type ContextRole = 'inject' | 'recall'

/** Role and producer name presented for one logged non-user message. */
export interface ContextProducerView {
  /** The role this context plays in the model-facing conversation. */
  role: ContextRole
  /**
   * Producer name for the row header, taken from the durable source: the
   * instruction paths, the referenced session titles, the plugin id, or the
   * bare source kind for a producer this UI version does not know. Null only
   * when the source carries no readable kind at all.
   */
  label: string | null
}

/**
 * One durable context form this UI version knows how to present. Target
 * projections map absent or unknown forms to their opaque presentation so
 * logs written by older, newer, or foreign producers remain visible.
 */
export type KnownContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'
