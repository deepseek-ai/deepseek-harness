/** Client-safe configuration form views and change notifications. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Nominal id of one profile plugin entry. */
export type SettingsNamespace = Branded<'SettingsNamespace'>

/** One schema-declared secret slot inside a redacted namespace value. */
export interface SettingsSecretView {
  /** Path from the section root to the removed field. */
  path: string[]
  /** Whether the slot currently holds a value; the value itself never rides. */
  set: boolean
}

/**
 * Wire view of one profile plugin entry, always read under `redactSecrets`. The
 * JSON-valued fields are `JsonValue` rather than the descriptor's `unknown`
 * because the Remote boundary admits no unconstrained data.
 */
export interface SettingsNamespaceView {
  /** Generate a page if no custom page is registered for this instance. */
  autoGenerate: boolean
  /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
  ns: string
  /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
  schema: JsonValue
  /** Redacted resolved value (schema defaults → composition base → user layer). */
  value: JsonValue
  /** Redacted composition base layer, with defaults resolved. */
  base?: JsonValue
  /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
  user?: JsonValue
  /** When the owner applies changes. */
  applies: 'live'
  /** Every schema-declared secret slot with its configured state. */
  secrets: SettingsSecretView[]
  /**
   * Monotonic revision of the raw entry configuration this view was read at. Send it
   * back as `expectedRevision` on a write so a stale editor is refused rather
   * than silently overwriting a concurrent change.
   */
  revision: number
}

/**
 * One path-addressed edit carried by a remote settings write. `set` writes the
 * value at the path, creating intermediate objects; `unset` removes it. The
 * empty path addresses the section root.
 */
export type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: JsonValue }
  | { op: 'unset'; path: string[] }

/** Every profile plugin entry with the deployment facts a configuration page renders around them. */
export interface SettingsDescribeValue {
  /** Whether the profile accepts writes; `false` disables every write control. */
  writable: boolean
  /** Whether the configuration editor owns a local document, without exposing its Host path. */
  hasDocument: boolean
  /** One view per profile plugin entry. */
  namespaces: SettingsNamespaceView[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One profile entry's form values, availability, or page policy changed.
     * Form clients re-read its schema, resolved values, and revision.
     * @param ns Profile entry id.
     * @param revision The entry's new revision.
     * @mode emit
     */
    'settings/document-updated'(ns: SettingsNamespace, revision: number): void
  }
}
