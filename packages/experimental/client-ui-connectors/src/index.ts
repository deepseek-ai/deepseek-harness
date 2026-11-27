/**
 * Host half of Connectors: the `connectors` service, present while the Connectors bundle is enabled. Its Remote streams
 * the MCP server rows of the profile's composition and saves, removes, or switches one as a single Host operation;
 * while the MCP account service runs, it shows the account of each OAuth server row that is on.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import type ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { credentialKey, type CredentialKey, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-mcp-account'
import type McpServerManager from '@deepseek-ai/dsh-mcp-manager'
import { Config as ServerRowConfig } from '@deepseek-ai/dsh-mcp-manager/server'
import type { ChangeResult, PluginEntryId, PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { serverCopy } from './server-copy.ts'
import { entryFromDraft, entryRefs, holdsExpression, ownedRefs, validateDraft } from './server-form.ts'
import type { CustomServersList, CustomServerStatus, CustomServerView, ServerDraft } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Connectors tab's custom MCP servers; present while the Connectors bundle is enabled. */
    connectors: Connectors
  }
}

/** The module name of the MCP manager's server row plugin. */
const SERVER_ROW = '@deepseek-ai/dsh-mcp-manager/server'

type Row = ReturnType<ConfigEditor['configuration']>[number]
type RowConfig = Readonly<Record<string, JsonValue>>

/** One MCP server row as the list and a change read it. */
interface ServerRow {
  readonly entry: Row['entry']
  /** The row's config when it is a map, whether or not the form can edit it. */
  readonly config: RowConfig | undefined
  readonly view: CustomServerView
}

/** The services the custom servers need. */
interface Services {
  readonly editor: ConfigEditor
  readonly plugins: PluginManager
  readonly credentials: CredentialProvider
  readonly manager: McpServerManager
}

/** The services and server rows one change works with, read at the revision the caller named. */
interface Change extends Services {
  readonly rows: readonly ServerRow[]
}

function record(value: unknown): RowConfig | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RowConfig : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function refused(server: string, message: string, cause?: unknown): RemoteError {
  return new RemoteError('connectors/refused', message, { server }, { cause })
}

function conflict(server: string, cause?: unknown): RemoteError {
  return new RemoteError('connectors/conflict', 'the server rows changed; read the servers again', { server }, { cause })
}

/** The row's config when the form can edit it. */
function editable(config: RowConfig | undefined): RowConfig | undefined {
  if (config === undefined || typeof config.serverName !== 'string') return undefined
  if (config.transport !== 'stdio' && config.transport !== 'streamable-http') return undefined
  return holdsExpression(config) ? undefined : config
}

/** Whether a row is switched off, runs, or is switched on without running, with the reason it does not run. */
async function stateOf(entry: Row['entry']): Promise<CustomServerStatus> {
  try {
    // A `disabled` expression that throws leaves the row switched on and not running, as app-boot reports it.
    if (entry.disabled) return { state: 'off' }
    await entry.fiber?.await()
  } catch (error) {
    return { state: 'failed', error: messageOf(error) }
  }
  return entry.fiber?.state === FiberState.ACTIVE ? { state: 'on' } : { state: 'failed', error: 'the server row is not running' }
}

async function readRow({ entry, inserted }: Row): Promise<ServerRow> {
  const options: unknown = entry.options.config
  const config = record(options)
  const id = entry.options.id
  const name = typeof config?.serverName === 'string' ? config.serverName : id
  const raw = editable(config)
  return { entry, config, view: { id, name, ...await stateOf(entry), ...raw === undefined ? {} : { raw }, inherited: !inserted } }
}

/** Read every MCP server row of the profile's composition, including rows that are off and rows that did not start. */
function readRows(editor: ConfigEditor): Promise<ServerRow[]> {
  return Promise.all(editor.configuration().filter(row => row.entry.options.name === SERVER_ROW).map(readRow))
}

/** A digest of the rows' ids, configs, and switches, and of which rows the profile patch adds. */
function revisionOf(rows: readonly ServerRow[]): string {
  const facts = rows.map(row => [row.view.id, row.config, row.view.state === 'off', row.view.inherited])
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

/**
 * Streams and changes the MCP server rows of the profile's composition for the Connectors tab, and shows the account of
 * each OAuth server row that is on.
 */
export class Connectors extends TypertRemoteService {
  /** A service method's `this.ctx` is the caller's context, so the methods reach the other services through this one. */
  private readonly host: Context
  private readonly watchers = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()

  /** @param ctx - the Host plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'connectors')
    this.host = ctx
    ctx.on('app-boot/config-reload', () => { this.changed() })
    ctx.on('plugin-manager/changed', () => { this.changed() })
    ctx.effect(() => () => { this.lifetime.abort() }, 'connectors: server streams')
    ctx.inject(['mcpAccounts', 'configEditor'], (scope) => { this.showAccounts(scope) })
  }

  /**
   * Stream the MCP server rows: the rows of the profile's composition that load the MCP manager's server row plugin,
   * including rows that are switched off and rows that did not start. A list follows every successful reload of the
   * composition, every change the plugin manager reports, and every change made through this service.
   * @param signal - ends the stream.
   * @returns each list with the revision a change names, or that the profile has no configuration editor, plugin
   *   manager, credentials, or MCP manager to keep custom servers with.
   */
  @Remote({ mode: 'stream' })
  async* watchServers(signal: AbortSignal): AsyncIterable<CustomServersList> {
    for await (const _tick of this.ticks(signal)) yield await this.list()
  }

  /**
   * Save one server from the form. A new server becomes the row `mcp-server-<name>` of the profile patch, switched on;
   * an edit replaces the config of the row `id` names. The save writes the row, stores the secret values entered in
   * the form, then deletes the secrets the row stopped using; an edit that drops OAuth removes the grant first. The
   * first refused step stops the save, so a refused write stores nothing. A row that is switched on must run after the
   * write: when it does not start, the configuration editor restores the profile patch and the save is refused with
   * the row's failure, while a row that is switched off is only written. The manager starts a written row at once and
   * connects it again when a secret it references is stored after that. A save is refused when a reference under the
   * server's own prefix is used by another row, and it never deletes a reference another row still uses, whether that
   * row is on or off.
   * @param draft - the form's values, including newly entered secret values.
   * @param revision - the revision of the list the save was made on.
   * @param id - the row to edit; omitted for a new server.
   * @throws RemoteError `connectors/conflict` when the server rows changed after that revision, or
   *   `connectors/refused` for a draft the form would not save, a config the row plugin's schema rejects, or the first
   *   refused step.
   */
  @Remote
  saveServer(draft: ServerDraft, revision: string, id?: string): Promise<void> {
    return this.serial(async () => {
      const { name } = draft
      const change = await this.begin(name, revision)
      const row = id === undefined ? undefined : change.rows.find(other => other.view.id === id)
      if (id !== undefined && (row?.view.raw === undefined || row.view.name !== name)) {
        throw refused(name, 'the server row cannot be edited: it is gone, the form cannot read it, or the draft renames it')
      }
      const previous = row?.view.raw
      const others = change.rows.filter(other => other !== row)
      const problems = validateDraft(draft, others.map(other => other.view.name), previous)
      if (problems.length > 0) throw refused(name, `the server cannot be saved: ${problems.join(', ')}`)
      // A draft keeps a stored secret only by a reference its entry already uses, so it cannot reach another secret.
      const used = new Set(previous === undefined ? [] : entryRefs(previous))
      const named = [...draft.headers, ...draft.env].map(item => item.ref).concat(draft.tokenRef)
      if (named.some(ref => ref !== undefined && !used.has(ref))) throw refused(name, 'the server names a credential reference its entry does not use')
      const { entry, secrets } = entryFromDraft(draft, previous)
      const foreign = foreignRefs(others)
      const shared = ownedRefs(name, entry).find(ref => foreign.has(ref))
      if (shared !== undefined) throw refused(name, `the server would share the credential reference ${shared} with another server`)
      // A row that is off is written without starting, so the row plugin's schema is checked here.
      await step(name, () => { z.resolve(entry, ServerRowConfig, {}) })
      if (row !== undefined && previous?.oauth !== undefined && entry.oauth === undefined) await dropGrant(change, row, name)
      if (row === undefined) await step(name, () => change.editor.insert({ id: `mcp-server-${name}`, name: SERVER_ROW, config: entry }))
      else await replace(change, row, entry)
      for (const secret of secrets) await step(name, () => change.credentials.set(brandString<CredentialRef>(secret.ref), secret.value))
      const kept = new Set(ownedRefs(name, entry))
      const dropped = previous === undefined ? [] : ownedRefs(name, previous).filter(ref => !kept.has(ref) && !foreign.has(ref))
      await release(change, name, dropped)
    })
  }

  /**
   * Remove one server row the profile patch adds: remove an OAuth server's grant, delete the row with its overrides,
   * then delete the secrets it owned that no other row uses. The first refused step stops the removal. A row the form
   * cannot read is removed without its grant and secrets.
   * @param id - the row.
   * @param revision - the revision of the list the removal was made on.
   * @throws RemoteError `connectors/conflict` when the server rows changed after that revision, or
   *   `connectors/refused` for a row the profile patch does not add, or the first refused step.
   */
  @Remote
  removeServer(id: string, revision: string): Promise<void> {
    return this.serial(async () => {
      const change = await this.begin(id, revision)
      const row = rowOf(change, id)
      const { name, raw: previous } = row.view
      // Refused before any step, so a row that cannot be removed keeps its grant.
      if (row.view.inherited) throw refused(id, 'the profile patch does not add this server row; switch it off instead of removing it')
      if (previous?.oauth !== undefined) await dropGrant(change, row, id)
      await step(id, () => change.editor.remove(row.entry))
      const foreign = foreignRefs(change.rows.filter(other => other !== row))
      await release(change, id, previous === undefined ? [] : ownedRefs(name, previous).filter(ref => !foreign.has(ref)))
    })
  }

  /**
   * Switch one server row on or off through the plugin manager, which writes the switch to the profile patch and
   * reloads the composition. A row that does not start after it is switched on stays switched on and is listed as
   * failed.
   * @param id - the row.
   * @param enabled - whether the row runs.
   * @param revision - the revision of the list the switch was made on.
   * @throws RemoteError `connectors/conflict` when the server rows changed after that revision, or
   *   `connectors/refused` when the switch did not take effect: the row did not start, another patch decides the
   *   switch, or the composition applies it only after a restart.
   */
  @Remote
  setServerEnabled(id: string, enabled: boolean, revision: string): Promise<void> {
    return this.serial(async () => {
      const change = await this.begin(id, revision)
      const row = rowOf(change, id)
      const result = await step(id, () => change.plugins.setPluginEnabled(brandString<PluginEntryId>(row.entry.id), enabled))
      const refusal = switchRefusal(result)
      if (refusal !== undefined) throw refused(id, refusal)
    })
  }

  private services(): Services | undefined {
    const editor = this.host.get('configEditor')
    const plugins = this.host.get('pluginManager')
    const credentials = this.host.get('credentials')
    const manager = this.host.get('mcpManager')
    if (editor === undefined || plugins === undefined || credentials === undefined || manager === undefined) return undefined
    return { editor, plugins, credentials, manager }
  }

  private async list(): Promise<CustomServersList> {
    const services = this.services()
    if (services === undefined) return { available: false }
    const rows = await readRows(services.editor)
    return { available: true, revision: revisionOf(rows), servers: rows.map(row => row.view) }
  }

  /** Read the server rows for a change, refusing one whose revision is no longer current before any step runs. */
  private async begin(server: string, revision: string): Promise<Change> {
    const services = this.services()
    if (services === undefined) {
      throw refused(server, 'custom MCP servers need the profile configuration editor, the plugin manager, credentials, and the MCP manager')
    }
    const rows = await step(server, () => readRows(services.editor))
    if (revisionOf(rows) !== revision) throw conflict(server)
    return { ...services, rows }
  }

  /**
   * Run one change after every earlier one, so each reads the rows the one before it left, and wake the streams when
   * it settles: a refused write can leave rows inactive, which no event reports.
   */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run).finally(() => { this.changed() })
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  /** Wake every stream of this service. */
  private changed(): void {
    for (const notify of this.watchers) notify()
  }

  /** Yield once at subscription, then once after each wake; wakes that arrive before the consumer returns make one tick. */
  private async* ticks(signal: AbortSignal): AsyncGenerator<void> {
    const ended = AbortSignal.any([signal, this.lifetime.signal])
    let next = Promise.withResolvers<void>()
    const notify = (): void => { next.resolve() }
    this.watchers.add(notify)
    ended.addEventListener('abort', notify, { once: true })
    try {
      while (!ended.aborted) {
        yield
        await next.promise
        next = Promise.withResolvers<void>()
      }
    } finally {
      this.watchers.delete(notify)
      ended.removeEventListener('abort', notify)
    }
  }

  /**
   * Register the account of each OAuth server row that is on with `scope.mcpAccounts`, following the rows
   * `scope.configEditor` lists, until the scope ends. A server whose account a connector already registered keeps that
   * account.
   */
  private showAccounts(scope: Context): void {
    scope.effect(() => {
      const ending = new AbortController()
      const shown = new Map<string, () => void>()
      const following = this.followAccounts(scope, shown, ending.signal)
      return async () => {
        ending.abort()
        await following
        for (const withdraw of shown.values()) withdraw()
      }
    }, 'connectors: server row accounts')
  }

  private async followAccounts(scope: Context, shown: Map<string, () => void>, signal: AbortSignal): Promise<void> {
    for await (const _tick of this.ticks(signal)) {
      let rows: readonly ServerRow[]
      try {
        rows = await readRows(scope.configEditor)
      } catch (error) {
        scope.logger.warn('connectors: server row accounts were not read: %s', messageOf(error))
        continue
      }
      // The scope ended during the read, so its account service takes no registration.
      if (signal.aborted) return
      const oauth = new Set(rows.filter(row => row.view.state === 'on' && row.view.raw?.oauth !== undefined).map(row => row.view.name))
      for (const [name, withdraw] of shown) {
        if (oauth.has(name)) continue
        withdraw()
        shown.delete(name)
      }
      for (const name of oauth) {
        if (shown.has(name)) continue
        try {
          shown.set(name, scope.mcpAccounts.register({ server: name, copy: serverCopy(name) }))
        } catch (error) {
          scope.logger.warn('connectors: server row "%s" shows no account: %s', name, messageOf(error))
        }
      }
    }
  }
}

/** Run one step of a change; its refusal stops the change. */
async function step<T>(server: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw refused(server, messageOf(error), error)
  }
}

/** The listed row a removal or a switch names. */
function rowOf(change: Change, id: string): ServerRow {
  const row = change.rows.find(other => other.view.id === id)
  if (row === undefined) throw refused(id, 'the server row is gone')
  return row
}

/** Replace one row's config; a row whose config changed after the revision check is a conflict. */
async function replace(change: Change, row: ServerRow, entry: RowConfig): Promise<void> {
  const seen = { stale: false }
  try {
    await change.editor.editRow(row.entry, (current) => {
      // Another writer can change the row between the revision check and the profile lock.
      seen.stale = !isDeepStrictEqual(current, row.config)
      if (seen.stale) throw new Error('the server row changed')
      return entry
    })
  } catch (error) {
    throw seen.stale ? conflict(row.view.name, error) : refused(row.view.name, messageOf(error), error)
  }
}

/** The OAuth grant record a row's config names, or undefined when it names none the credentials service could hold. */
function grantKey(config: RowConfig | undefined): CredentialKey | undefined {
  const key = record(config?.oauth)?.credentialKey
  if (typeof key !== 'string') return undefined
  const slash = key.indexOf('/')
  if (slash < 0) return undefined
  try {
    return credentialKey(key.slice(0, slash), key.slice(slash + 1))
  } catch (_error) {
    // The manager refuses a malformed key at registration, so no grant is stored under it.
    return undefined
  }
}

/**
 * Remove the OAuth grant of a row that stops using it. The manager signs out a server that is on, which closes its
 * connections first. For a row that is off or did not start, the record its config names is deleted from the
 * credentials store, unless another server row names the same record or the name of a server the manager holds forms
 * its key: a connector registers its server without a row and keeps its grant under `mcp-client/<server name>`.
 */
async function dropGrant(change: Change, row: ServerRow, server: string): Promise<void> {
  if (row.view.state === 'on') {
    await step(server, () => change.manager.signOut(row.view.name))
    return
  }
  const key = grantKey(row.config)
  if (key === undefined) return
  const shared = change.rows.some(other => other !== row && grantKey(other.config) === key)
    || change.manager.list().some(listed => listed.configured && `mcp-client/${listed.name}` === key)
  if (!shared) await step(server, () => change.credentials.deleteRecord(key))
}

/**
 * The credential references the other rows' configs use, whether or not the form can read those rows: a save never
 * takes one over, and a removal never deletes one.
 */
function foreignRefs(others: readonly ServerRow[]): Set<string> {
  return new Set(others.flatMap(other => other.config === undefined ? [] : entryRefs(other.config)))
}

/** Delete the secrets no row references any more; the first refusal stops. */
async function release(change: Change, server: string, refs: readonly string[]): Promise<void> {
  for (const ref of refs) await step(server, () => change.credentials.unset(brandString<CredentialRef>(ref)))
}

/** Why a switch did not take effect, or undefined when it did. */
function switchRefusal(result: ChangeResult): string | undefined {
  switch (result.application) {
    case 'applied': return undefined
    case 'restart-required': return 'the switch is saved and takes effect after DSH restarts'
    case 'overridden': return 'a home patch or command-line overlay decides whether this server is on'
    case 'failed':
    case 'cancelled': return result.error?.diagnostic ?? result.error?.code ?? 'the plugin manager did not apply the switch'
    /* v8 ignore next -- ChangeResult.application is a closed union */
    default: return assertNever(result.application)
  }
}

export default Connectors
