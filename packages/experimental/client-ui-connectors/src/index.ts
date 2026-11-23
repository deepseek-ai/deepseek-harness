/**
 * Host half of Connectors: the `connectors` service, present while the Connectors bundle is enabled. Its Remote lists
 * the MCP servers configured in the MCP manager's Settings and saves, removes, or switches one as a single Host
 * operation; while the MCP account service runs, it shows the account of each configured OAuth server.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-mcp-account'
import type McpServerManager from '@deepseek-ai/dsh-mcp-manager'
import type { SettingsDescriptor, SettingsForms, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { serverCopy } from './server-copy.ts'
import { entryFromDraft, entryRefs, ownedRefs, validateDraft } from './server-form.ts'
import type { CustomServersList, CustomServerView, ServerDraft } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Connectors tab's custom MCP servers; present while the Connectors bundle is enabled. */
    connectors: Connectors
  }
}

/** Where the custom servers live. */
export interface Config {
  /** The MCP manager's Settings namespace: the id of its composition row. */
  mcpManagerNamespace: string
}

type Entry = Readonly<Record<string, JsonValue>>

/** The services and servers one change works with, read at the revision the caller named. */
interface Change {
  readonly settings: SettingsForms
  readonly credentials: CredentialProvider
  readonly manager: McpServerManager
  readonly servers: readonly CustomServerView[]
}

function record(value: unknown): Entry | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Entry : undefined
}

/** The namespace's servers in document order, marking those the composition base defines and those the form cannot edit. */
function serversOf(view: SettingsDescriptor): CustomServerView[] {
  const base = record(record(view.base)?.servers) ?? {}
  return Object.entries(record(record(view.value)?.servers) ?? {}).map(([name, value]) => {
    const raw = record(value)
    const known = raw !== undefined && (raw.transport === 'stdio' || raw.transport === 'streamable-http')
    return { name, ...known ? { raw } : {}, inherited: Object.hasOwn(base, name) }
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function refused(server: string, message: string, cause?: unknown): RemoteError {
  return new RemoteError('connectors/refused', message, { server }, { cause })
}

/** The Settings conflict code is the seam's stable answer to a stale revision. */
function conflictOf(error: unknown): { readonly expected: number; readonly actual: number } | undefined {
  if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'SETTINGS_CONFLICT') return undefined
  const expected: unknown = Reflect.get(error, 'expected')
  const actual: unknown = Reflect.get(error, 'actual')
  return typeof expected === 'number' && typeof actual === 'number' ? { expected, actual } : undefined
}

function conflict(expected: number, actual: number, cause?: unknown): RemoteError {
  return new RemoteError('connectors/conflict', 'the MCP manager settings changed; read the servers again', { expected, actual }, { cause })
}

/**
 * Register the account of each configured OAuth server with `ctx.mcpAccounts`, following the namespace's changes, until
 * the scope ends. A server whose account a connector already registered keeps that account.
 * @param scope - a context carrying Settings and the MCP account service.
 * @param namespace - the MCP manager's Settings namespace.
 */
function showServerAccounts(scope: Context, namespace: string): void {
  scope.effect(() => {
    const shown = new Map<string, () => void>()
    const sync = (): void => {
      const view = scope.settings.describe().find(row => row.ns === namespace)
      const servers = view === undefined ? [] : serversOf(view)
      const oauth = new Set(servers.filter(server => server.raw?.oauth !== undefined).map(server => server.name))
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
          scope.logger.warn('connectors: configured server "%s" shows no account: %s', name, messageOf(error))
        }
      }
    }
    sync()
    const stop = scope.on('settings/document-updated', (changed) => { if (changed === namespace) sync() })
    return () => {
      stop()
      for (const withdraw of shown.values()) withdraw()
    }
  }, 'connectors: configured server accounts')
}

/** Lists and changes the MCP manager's Settings servers for the Connectors tab, and shows each configured OAuth server's account. */
export class Connectors extends TypertRemoteService {
  static Config: z<Partial<Config>, Config> = z.object({ mcpManagerNamespace: z.string().min(1).default('mcp-manager') })

  /** A service method's `this.ctx` is the caller's context, so the methods reach Settings and the manager through this one. */
  private readonly host: Context

  /**
   * @param ctx - the Host plugin context.
   * @param config - the MCP manager's Settings namespace.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'connectors')
    this.host = ctx
    ctx.inject(['settings', 'mcpAccounts'], (scope) => { showServerAccounts(scope, config.mcpManagerNamespace) })
  }

  /**
   * List the servers of the MCP manager's Settings namespace with secrets redacted.
   * @returns the servers and the revision a change names, or that the profile has no Settings, credentials, or manager
   *   to keep custom servers with.
   */
  @Remote
  listServers(): CustomServersList {
    const settings = this.host.get('settings')
    const view = settings?.describe({ redactSecrets: true }).find(row => row.ns === this.config.mcpManagerNamespace)
    if (settings === undefined || view === undefined || this.host.get('credentials') === undefined || this.host.get('mcpManager') === undefined) {
      return { available: false }
    }
    return { available: true, writable: settings.writable, revision: view.revision, servers: serversOf(view) }
  }

  /**
   * Save one server from the form: write the entry, store the secret values entered in it, then delete the secrets the
   * entry stopped using. An edit that drops OAuth signs the server out first, because the manager deletes a grant only
   * while the entry still configures OAuth. The first refused step stops the save, so a refused write stores nothing;
   * the manager starts the written entry at once and connects it again when a secret it references is stored after
   * that. A save is refused when a reference under the server's own prefix is used by another server's entry, and it
   * never deletes a reference another entry still uses.
   * @param draft - the form's values, including newly entered secret values.
   * @param revision - the namespace revision the list last read.
   * @throws RemoteError `connectors/conflict` when Settings changed after that revision, or `connectors/refused` for a
   *   draft the form would not save or the first refused step.
   */
  @Remote
  async saveServer(draft: ServerDraft, revision: number): Promise<void> {
    const { name } = draft
    const change = this.change(name, revision)
    const previous = change.servers.find(server => server.name === name)?.raw
    const problems = validateDraft(draft, change.servers.map(server => server.name).filter(other => other !== name))
    if (problems.length > 0) throw refused(name, `the server cannot be saved: ${problems.join(', ')}`)
    // A draft keeps a stored secret only by a reference its entry already uses, so it cannot reach another secret.
    const used = new Set(previous === undefined ? [] : entryRefs(previous))
    const named = [...draft.headers, ...draft.env].map(row => row.ref).concat(draft.tokenRef)
    if (named.some(ref => ref !== undefined && !used.has(ref))) throw refused(name, 'the server names a credential reference its entry does not use')
    const { entry, secrets } = entryFromDraft(draft, previous)
    const foreign = foreignRefs(change, name)
    const shared = ownedRefs(name, entry).find(ref => foreign.has(ref))
    if (shared !== undefined) throw refused(name, `the server would share the credential reference ${shared} with another server`)
    if (previous?.oauth !== undefined && entry.oauth === undefined) await step(name, () => change.manager.signOut(name))
    await this.write(change, name, [{ op: 'set', path: ['servers', name], value: entry }], revision)
    for (const secret of secrets) await step(name, () => change.credentials.set(brandString<CredentialRef>(secret.ref), secret.value))
    const kept = new Set(ownedRefs(name, entry))
    await release(change, name, previous === undefined ? [] : ownedRefs(name, previous).filter(ref => !kept.has(ref) && !foreign.has(ref)))
  }

  /**
   * Remove one server: sign an OAuth server out, delete its entry, then delete the secrets it owned that no other entry
   * uses. The first refused step stops the removal.
   * @param name - the server.
   * @param revision - the namespace revision the list read.
   * @throws RemoteError `connectors/conflict` when Settings changed after that revision, or `connectors/refused` for the
   *   first refused step.
   */
  @Remote
  async removeServer(name: string, revision: number): Promise<void> {
    const change = this.change(name, revision)
    const previous = change.servers.find(server => server.name === name)?.raw
    if (previous?.oauth !== undefined) await step(name, () => change.manager.signOut(name))
    await this.write(change, name, [{ op: 'unset', path: ['servers', name] }], revision)
    const foreign = foreignRefs(change, name)
    await release(change, name, previous === undefined ? [] : ownedRefs(name, previous).filter(ref => !foreign.has(ref)))
  }

  /**
   * Switch one server on or off.
   * @param name - the server.
   * @param enabled - whether the manager runs it.
   * @param revision - the namespace revision the list read.
   * @throws RemoteError `connectors/conflict` when Settings changed after that revision, or `connectors/refused` when
   *   the write is refused.
   */
  @Remote
  async setServerEnabled(name: string, enabled: boolean, revision: number): Promise<void> {
    await this.write(this.change(name, revision), name, [{ op: 'set', path: ['servers', name, 'enabled'], value: enabled }], revision)
  }

  /** Read the namespace for a change, refusing one whose revision is no longer current before any step runs. */
  private change(name: string, revision: number): Change {
    const settings = this.host.get('settings')
    const credentials = this.host.get('credentials')
    const manager = this.host.get('mcpManager')
    const view = settings?.describe().find(row => row.ns === this.config.mcpManagerNamespace)
    if (settings === undefined || credentials === undefined || manager === undefined || view === undefined) {
      throw refused(name, 'custom MCP servers need Settings, credentials, and the MCP manager')
    }
    if (view.revision !== revision) throw conflict(revision, view.revision)
    return { settings, credentials, manager, servers: serversOf(view) }
  }

  private async write(change: Change, name: string, ops: SettingsPathOp[], revision: number): Promise<void> {
    try {
      await change.settings.mutate(this.config.mcpManagerNamespace, ops, revision)
    } catch (error) {
      const stale = conflictOf(error)
      throw stale === undefined ? refused(name, messageOf(error), error) : conflict(stale.expected, stale.actual, error)
    }
  }
}

/** Run one step of a change; its refusal stops the change. */
async function step(server: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    throw refused(server, messageOf(error), error)
  }
}

/** The credential references the other servers' entries use: a save never takes one over, and a removal never deletes one. */
function foreignRefs(change: Change, server: string): Set<string> {
  const others = change.servers.filter(other => other.name !== server)
  return new Set(others.flatMap(other => other.raw === undefined ? [] : entryRefs(other.raw)))
}

/** Delete the secrets no entry references any more; the first refusal stops. */
async function release(change: Change, server: string, refs: readonly string[]): Promise<void> {
  for (const ref of refs) await step(server, () => change.credentials.unset(brandString<CredentialRef>(ref)))
}

export default Connectors
