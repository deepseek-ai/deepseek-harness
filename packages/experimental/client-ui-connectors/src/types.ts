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
  readonly enabled: boolean
}

/** A reason the form refuses to save; each has a `problem.<kind>` dictionary entry. */
export type DraftProblem =
  | 'name-invalid' | 'name-taken' | 'url-invalid' | 'command-missing' | 'token-missing'
  | 'row-key-missing' | 'row-key-duplicate' | 'row-secret-missing' | 'authorization-header' | 'name-oauth'

/** The entry to write, and the secret values to store under the references it uses. */
export interface DraftEntry {
  readonly entry: Readonly<Record<string, JsonValue>>
  readonly secrets: readonly { readonly ref: string; readonly value: string }[]
}

/** One server of the MCP manager's Settings namespace. */
export interface CustomServerView {
  readonly name: string
  /** The entry, or undefined when its transport is not one the form edits. */
  readonly raw?: Readonly<Record<string, JsonValue>> | undefined
  /** Whether the profile's composition base defines the server, so removing it would only restore the base entry. */
  readonly inherited: boolean
}

/** The servers the tab lists, or that the profile cannot hold custom servers. */
export type CustomServersList =
  | { readonly available: false }
  | {
    readonly available: true
    /** Whether the Settings provider accepts writes. */
    readonly writable: boolean
    /** The namespace revision a change must name. */
    readonly revision: number
    readonly servers: readonly CustomServerView[]
  }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The MCP manager's Settings changed after the caller read them; read the servers again before the next change. */
    'connectors/conflict': { readonly expected: number; readonly actual: number }
    /** The Host refused one step of a custom server change, which stopped there; the message names the refusal. */
    'connectors/refused': { readonly server: string }
  }
}
