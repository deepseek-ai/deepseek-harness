/** The server form's draft, and its conversion from and to a manager Settings entry with credential references. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { DraftEntry, DraftProblem, DraftRow, ServerDraft } from './types.ts'

export type { AuthKind, DraftEntry, DraftProblem, DraftRow, ServerDraft, Transport } from './types.ts'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
// The OAuth grant's credential key `mcp-client/<name>` accepts only this segment form.
const OAUTH_NAME = /^[a-z][a-z0-9-]*$/
const SECRET_VALUE = /^\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}$/
const BEARER_VALUE = /^Bearer \$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}$/
const CREDENTIAL_TOKEN = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g
const FORM_FIELDS = ['transport', 'url', 'headers', 'command', 'args', 'env', 'cwd', 'enabled', 'oauth']

/**
 * The draft of a new server.
 * @returns an enabled remote server without authentication.
 */
export function emptyDraft(): ServerDraft {
  return {
    name: '', transport: 'streamable-http', url: '', headers: [], command: '', args: [], env: [], cwd: '',
    auth: 'none', token: '', clientId: '', scope: '', enabled: true,
  }
}

/**
 * Name the credential reference of one field; names that differ only in case, `-`, or `_` map to the same reference.
 * @param server - the server name.
 * @param field - the field, such as `TOKEN` or `HEADER_<key>`.
 * @returns the reference, an identifier the credentials service accepts.
 */
export function credentialRef(server: string, field: string): string {
  return `MCP_${server}_${field}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function record(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function rows(values: Readonly<Record<string, JsonValue>>): DraftRow[] {
  return Object.entries(values).map(([key, raw]) => {
    const value = text(raw)
    const secret = SECRET_VALUE.exec(value)
    return secret === null ? { key, value, secret: false } : { key, value: '', secret: true, ref: secret[1] }
  })
}

/**
 * Read an entry into a draft; an `Authorization: Bearer ${credential:REF}` header becomes the header token.
 * @param name - the server name.
 * @param raw - the entry.
 * @returns the draft, with secret rows keeping their references and empty values.
 */
export function draftFromEntry(name: string, raw: Readonly<Record<string, JsonValue>>): ServerDraft {
  const headers = record(raw.headers)
  const authorization = Object.keys(headers).find(key => key.toLowerCase() === 'authorization')
  const bearer = authorization === undefined ? null : BEARER_VALUE.exec(text(headers[authorization]))
  const oauth = record(raw.oauth)
  const otherHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => bearer === null || key !== authorization))
  return {
    name,
    transport: raw.transport === 'stdio' ? 'stdio' : 'streamable-http',
    url: text(raw.url),
    headers: rows(otherHeaders),
    command: text(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map(text) : [],
    env: rows(record(raw.env)),
    cwd: text(raw.cwd),
    auth: bearer !== null ? 'token' : raw.oauth !== undefined ? 'oauth' : 'none',
    token: '',
    tokenRef: bearer?.[1],
    clientId: text(oauth.clientId),
    scope: text(oauth.scope),
    enabled: raw.enabled !== false,
  }
}

/**
 * List why a draft cannot be saved.
 * @param draft - the draft.
 * @param taken - the names of the other servers.
 * @returns the problems, empty when the draft can be saved.
 */
export function validateDraft(draft: ServerDraft, taken: readonly string[]): DraftProblem[] {
  const problems: DraftProblem[] = []
  if (!SERVER_NAME.test(draft.name)) problems.push('name-invalid')
  // Names and keys that differ only in case, `-`, or `_` would share a credential reference.
  else if (taken.some(other => credentialRef(other, '') === credentialRef(draft.name, ''))) problems.push('name-taken')
  const keyed = draft.transport === 'stdio' ? draft.env : draft.headers
  if (keyed.some(row => row.key.trim() === '')) problems.push('row-key-missing')
  // Keys that would map to one reference, and secret rows that would store their values under one reference, since a
  // renamed secret row keeps the reference its key no longer names; a bearer token is stored under one too.
  const prefix = draft.transport === 'stdio' ? 'ENV' : 'HEADER'
  const refs = keyed.filter(row => row.secret).map(row => rowRef(draft.name, prefix, row))
  if (draft.transport !== 'stdio' && draft.auth === 'token') refs.push(draft.tokenRef ?? credentialRef(draft.name, 'TOKEN'))
  if (new Set(keyed.map(row => credentialRef('', row.key.trim()))).size !== keyed.length || new Set(refs).size !== refs.length) {
    problems.push('row-key-duplicate')
  }
  if (keyed.some(row => row.secret && row.value === '' && row.ref === undefined)) problems.push('row-secret-missing')
  if (draft.transport === 'stdio') {
    if (draft.command.trim() === '') problems.push('command-missing')
    return problems
  }
  if (!URL.canParse(draft.url) || !['http:', 'https:'].includes(new URL(draft.url).protocol)) problems.push('url-invalid')
  if (draft.auth === 'token' && draft.token === '' && draft.tokenRef === undefined) problems.push('token-missing')
  if (draft.auth === 'oauth' && SERVER_NAME.test(draft.name) && !OAUTH_NAME.test(draft.name)) problems.push('name-oauth')
  if (draft.auth !== 'none' && draft.headers.some(row => row.key.trim().toLowerCase() === 'authorization')) problems.push('authorization-header')
  return problems
}

/** The reference a secret row stores its value under: the one it keeps, or a new one named after the server and key. */
function rowRef(name: string, prefix: string, row: DraftRow): string {
  return row.ref ?? credentialRef(name, `${prefix}_${row.key.trim()}`)
}

function rowValues(
  name: string, prefix: string, draftRows: readonly DraftRow[], secrets: { ref: string; value: string }[],
): Record<string, string> {
  return Object.fromEntries(draftRows.map((row) => {
    const key = row.key.trim()
    if (!row.secret) return [key, row.value]
    const ref = rowRef(name, prefix, row)
    if (row.value !== '') secrets.push({ ref, value: row.value })
    return [key, `\${credential:${ref}}`]
  }))
}

/**
 * Write a draft as an entry, keeping the fields of the previous entry that the form does not edit.
 * @param draft - the draft.
 * @param raw - the previous entry, if any.
 * @returns the entry and the secret values entered in the form.
 */
export function entryFromDraft(draft: ServerDraft, raw: Readonly<Record<string, JsonValue>> = {}): DraftEntry {
  const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => !FORM_FIELDS.includes(key)))
  const secrets: { ref: string; value: string }[] = []
  if (draft.transport === 'stdio') {
    const args = draft.args.map(arg => arg.trim()).filter(arg => arg !== '')
    return {
      entry: {
        ...kept, transport: 'stdio', command: draft.command.trim(), args, env: rowValues(draft.name, 'ENV', draft.env, secrets),
        ...draft.cwd.trim() === '' ? {} : { cwd: draft.cwd.trim() }, enabled: draft.enabled,
      },
      secrets,
    }
  }
  const headers = rowValues(draft.name, 'HEADER', draft.headers, secrets)
  if (draft.auth === 'token') {
    const ref = draft.tokenRef ?? credentialRef(draft.name, 'TOKEN')
    if (draft.token !== '') secrets.push({ ref, value: draft.token })
    headers.Authorization = `Bearer \${credential:${ref}}`
  }
  const oauth = draft.auth === 'oauth'
    ? { oauth: { credentialKey: `mcp-client/${draft.name}`, ...draft.clientId.trim() === '' ? {} : { clientId: draft.clientId.trim() },
      ...draft.scope.trim() === '' ? {} : { scope: draft.scope.trim() } } }
    : {}
  return { entry: { ...kept, transport: 'streamable-http', url: draft.url.trim(), headers, ...oauth, enabled: draft.enabled }, secrets }
}

/**
 * List the credential references an entry uses in the values the MCP manager expands: the URL, each header value, the
 * command, each argument, each environment value, and the working directory, with every reference of a value.
 * @param raw - the entry.
 * @returns the references, each once.
 */
export function entryRefs(raw: Readonly<Record<string, JsonValue>>): string[] {
  const values = [
    raw.url, ...Object.values(record(raw.headers)),
    raw.command, ...Array.isArray(raw.args) ? raw.args : [], ...Object.values(record(raw.env)), raw.cwd,
  ]
  return [...new Set(values.flatMap(value => [...text(value).matchAll(CREDENTIAL_TOKEN)].map(token => token[1] as string)))]
}

/**
 * List the credential references a server's entry uses under the server's own prefix.
 * @param name - the server name.
 * @param raw - the entry.
 * @returns the references, each once.
 */
export function ownedRefs(name: string, raw: Readonly<Record<string, JsonValue>>): string[] {
  const prefix = credentialRef(name, '')
  return entryRefs(raw).filter(ref => ref.startsWith(prefix))
}
