/** API-key authentication, credential-gated discovery, and the official model listing for the official DeepSeek route. */
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY, INVALID_CREDENTIAL_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelBadge } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { DeepSeekAuthError } from '@deepseek-ai/dsh-deepseek-auth'
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
export const inject = ['llm', 'deepseekAuth']

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
  // Every other DeepSeek consumer billed by the API key sends this route's key to this route's deployment.
  ctx.effect(() => ctx.deepseekAuth.connect('api-key', PROVIDER, () => {
    const connection = options()
    return { baseURL: connection.baseURL, reference: connection.apiKeyEnv, owner: settingsNs }
  }), 'llm-deepseek-api-key: API-key deployment')
  /**
   * The key `ctx.deepseekAuth` releases for `endpoint` from one configuration generation, in the header Messages
   * expects; `undefined` when none is configured or `endpoint` is outside the route's deployment. An unusable key fails
   * as this route's `INVALID_CREDENTIAL`; store failures propagate.
   */
  const resolveAuth = async (connection: ResolvedDeepSeekOptions, endpoint: string): Promise<DeepSeekRequestAuth | undefined> => {
    try {
      return await ctx.deepseekAuth.authorize({
        consumer: settingsNs, accepts: ['api-key'], billing: 'api-key', destination: { url: endpoint },
        connections: { 'api-key': { baseURL: connection.baseURL, reference: connection.apiKeyEnv } },
        apiKeyHeaders: ['x-api-key'],
      })
    } catch (error) {
      if (error instanceof DeepSeekAuthError && error.code === 'INVALID_CREDENTIAL') {
        throw new LlmError(error.message, INVALID_CREDENTIAL_CODE, { cause: error })
      }
      throw error
    }
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
    admit: (connection, model) => { refuseListedModel(model, connection.refusals.get(model)) },
    discoverModels: async (provider) => {
      const connection = options()
      if (connection.listing === undefined) {
        if (await resolveAuth(connection, connection.baseURL) === undefined) return []
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
