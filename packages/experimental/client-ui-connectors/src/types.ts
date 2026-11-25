/** The custom MCP server form and list that cross the `connectors` Remote, and its Remote failures. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** How the manager reaches the server. */
export type Transport = 'streamable-http' | 'stdio'
/** How a remote server authenticates. */
export type AuthKind = 'none' | 'token' | 'oauth'

/** One header or environment row; a secret row keeps its stored reference until a new value replaces it. */
export interface DraftRow {
  readonly key: string
  readonly value: string
  readonly secret: boolean
  readonly ref?: string | undefined
}

/** Every field the form edits. */
export interface ServerDraft {
  readonly name: string
  readonly transport: Transport
  readonly url: string
  readonly headers: readonly DraftRow[]
  readonly command: string
  readonly args: readonly string[]
  readonly env: readonly DraftRow[]
  readonly cwd: string
  readonly auth: AuthKind
  readonly token: string
  readonly tokenRef?: string | undefined
  readonly clientId: string
  readonly scope: string
}

/** A reason the form refuses to save; each has a `problem.<kind>` dictionary entry. */
export type DraftProblem =
  | 'name-invalid' | 'name-taken' | 'url-invalid' | 'command-missing' | 'token-missing'
  | 'row-key-missing' | 'row-key-duplicate' | 'row-key-reserved' | 'row-secret-missing' | 'authorization-header' | 'name-oauth'

/** The server row config to write, and the secret values to store under the references it uses. */
export interface DraftEntry {
  readonly entry: Readonly<Record<string, JsonValue>>
  readonly secrets: readonly { readonly ref: string; readonly value: string }[]
}

/**
 * Whether one MCP server row runs: `on` for a row that is switched on and runs, `off` for one that is switched off, and
 * `failed`, with the reason, for one that is switched on and does not run.
 */
export type CustomServerStatus =
  | { readonly state: 'on' | 'off' }
  | { readonly state: 'failed'; readonly error: string }

/** One MCP server row of the profile's composition, with whether it runs. */
export type CustomServerView = CustomServerStatus & {
  /** The row id, which names the row in a change. */
  readonly id: string
  /** The server name, or the row id when the row's config carries no `serverName` string. */
  readonly name: string
  /**
   * The row's config, or undefined when the form cannot edit it: the config carries no `serverName` string, names a
   * transport the form does not know, or holds a `!!js` expression.
   */
  readonly raw?: Readonly<Record<string, JsonValue>> | undefined
  /**
   * Whether a layer other than the profile patch adds the row, such as a bundle; such a row can be edited and switched
   * but not removed.
   */
  readonly inherited: boolean
}

/** The servers the tab lists, or that the profile cannot hold custom servers. */
export type CustomServersList =
  | { readonly available: false }
  | {
    readonly available: true
    /** A digest of the listed rows' ids, configs, and switches, which a change must name. */
    readonly revision: string
    readonly servers: readonly CustomServerView[]
  }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * The server rows changed after the caller read them; the caller waits for the next list before the next change.
     * `server` names the server as the change did: the draft's name for a save, the row id for a removal or a switch.
     */
    'connectors/conflict': { readonly server: string }
    /**
     * The Host refused one step of a custom server change, which stopped there; the message names the refusal.
     * `server` names the server as the change did.
     */
    'connectors/refused': { readonly server: string }
  }
}
