/** API-key authentication, credential-gated discovery, and the official model listing for the official DeepSeek route. */
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY, assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelBadge } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRefConfigured, resolveCredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  catalogModelInfo, createModelListingCache, refuseListedModel, registerDeepSeekProvider, resolveListedCatalog,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { CatalogRefusal, DeepSeekCatalogModel, DeepSeekRequestAuth, ListingView, ModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import { Config, plainOptions, resolveAdapterOptions } from './config.ts'
import type { ResolvedDeepSeekOptions } from './config.ts'

export { Config } from './config.ts'
export type { Options, ResolvedDeepSeekOptions } from './config.ts'
export const name = 'llm-deepseek-api-key'
export const inject = ['llm']

const PROVIDER = 'deepseek-official'
/** Console tag of listing diagnostics; product profiles mount no console exporter for `ctx.logger`. */
const LOG_TAG = '[llm-deepseek-api-key]'

/** Connection facts of one operation: protocol settings plus the catalog resolved with them. */
interface OfficialConnection extends ResolvedDeepSeekOptions {
  /** Selectable models: the configured catalog, or the offered part of the followed listing. */
  readonly offered: readonly DeepSeekCatalogModel[]
  /** Listed models refused before network I/O, by id. */
  readonly refusals: ReadonlyMap<string, CatalogRefusal>
  /** Listed badges of offered models, by id; empty without a followed listing. */
  readonly badges: ReadonlyMap<string, LlmModelBadge>
}

export function apply(ctx: Context, config: Config): void {
  /** Settings namespace of this mount, which the provider directory lists and credential diagnostics name. */
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  const options = () => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx))
  options()
  /** The validated API key, or `undefined` when none is configured; store and format failures propagate. */
  const resolveApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string | undefined> => {
    const value = await resolveCredentialRef(ctx, connection.apiKeyEnv)
    return value === undefined ? undefined : assertUsableApiKey(value, settingsNs, connection.apiKeyEnv)
  }
  /**
   * Whether `endpoint` belongs to the deployment this route sends its key to: the origin of the route's base URL,
   * without credentials embedded in the URL.
   */
  const servedByRoute = (connection: ResolvedDeepSeekOptions, endpoint: string): boolean => {
    const destination = new URL(endpoint)
    return destination.origin === new URL(connection.baseURL).origin && destination.username === '' && destination.password === ''
  }
  const resolveAuth = async (connection: ResolvedDeepSeekOptions, endpoint: string): Promise<DeepSeekRequestAuth | undefined> => {
    // The store is read only for a destination this route serves, as the presence check below.
    if (!servedByRoute(connection, endpoint)) return undefined
    const key = await resolveApiKey(connection)
    return key === undefined ? undefined : { headers: { 'x-api-key': key }, value: key }
  }
  const missingCredential = (connection: ResolvedDeepSeekOptions) => new LlmError(
    `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${connection.apiKeyEnv} through the credentials`
    + ` service (the web Models page writes it), or export ${connection.apiKeyEnv} in the launching environment`,
    'MISSING_CREDENTIAL',
  )
  const listings = createModelListingCache(ctx, name, PROVIDER, {
    settings: () => options().listing,
    credential: async url => (await resolveAuth(options(), url))?.headers,
  })
  let reportedListing: ModelListing | undefined
  /** Resolve the catalog, reporting each listing's hidden entries and dropped badges once. */
  const connectionOf = (connection: ResolvedDeepSeekOptions, view: ListingView | undefined): OfficialConnection => {
    if (view === undefined) return { ...connection, offered: connection.models, refusals: new Map(), badges: new Map() }
    const catalog = resolveListedCatalog({
      listing: view.listing?.entries,
      supported: connection.models,
      overrides: {},
      routeMaxTokens: connection.maxTokens,
      clientVersion: APP_IDENTITY.version,
    })
    if (view.listing !== reportedListing) {
      reportedListing = view.listing
      for (const problem of catalog.problems) console.warn(LOG_TAG, problem)
    }
    return { ...connection, models: catalog.resolution, offered: catalog.offered, refusals: catalog.refusals, badges: catalog.badges }
  }
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs, settingsPath: [] },
  ])
  registerDeepSeekProvider<OfficialConnection>(ctx, PROVIDER, {
    providerName: 'DeepSeek',
    options: () => {
      const connection = options()
      return connectionOf(connection, connection.listing === undefined ? undefined : listings.current())
    },
    connect: async (signal) => {
      const connection = options()
      if (connection.listing === undefined) return connectionOf(connection, undefined)
      let view: ListingView
      try { view = await listings.view(connection.listing, signal) }
      catch (error) {
        if (signal?.aborted === true) throw error
        // The cache keeps the previous credential's listing when this lookup fails, so gate nothing;
        // `resolveAuth` reports the failure on the model request, after the turn records the prompt.
        return connectionOf(connection, undefined)
      }
      return connectionOf(connection, view)
    },
    resolveAuth,
    missingCredential,
    credential: {
      kind: 'api-key',
      reference: connection => connection.apiKeyEnv,
      configured: async (connection, endpoint) =>
        servedByRoute(connection, endpoint) && await credentialRefConfigured(ctx, connection.apiKeyEnv),
    },
    admit: (connection, model) => { refuseListedModel(model, connection.refusals.get(model)) },
    discoverModels: async (provider) => {
      const connection = options()
      if (connection.listing === undefined) {
        if (await resolveApiKey(connection) === undefined) return []
        return connection.models.map(model => catalogModelInfo(provider, model))
      }
      const view = await listings.view(connection.listing)
      if (!view.authenticated) return []
      const { offered, badges } = connectionOf(connection, view)
      return offered.map(model => catalogModelInfo(provider, model, badges.get(model.id)))
    },
  })
  // Starting or stopping to follow the listing discards it, so restoring the built-in
  // catalog after a customization reloads the listing on the next access.
  let following = options().listing !== undefined
  ctx.on('loader/volatile-update', () => {
    let next: boolean
    // The transport's own listener reports a configuration the adapter rejects.
    try { next = options().listing !== undefined }
    catch (_rejectedConfiguration) { return }
    if (next !== following) listings.invalidate()
    following = next
  })
}
