/** API-key authentication, credential-gated discovery, and the official model listing for the official DeepSeek route. */
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY, assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  catalogModelInfo, ModelListingCache, refuseListedModel, registerDeepSeekProvider, requestModelListing, resolveListedCatalog,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { CatalogRefusal, DeepSeekCatalogModel, ListingView, ModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import { Config, plainOptions, resolveAdapterOptions } from './config.ts'
import type { ResolvedDeepSeekOptions } from './config.ts'

export { Config, plainOptions, resolveAdapterOptions } from './config.ts'
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
}

export function apply(ctx: Context, config: Config): void {
  const options = () => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx))
  options()
  const resolveApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
    }
    throw new LlmError(
      `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }
  /** The API key, or `undefined` when none is configured; other credential failures propagate. */
  const presentApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string | undefined> => {
    try { return await resolveApiKey(connection) }
    catch (error) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return undefined
      throw error
    }
  }
  const listings = new ModelListingCache({
    credential: async () => presentApiKey(options()),
    load: (url, apiKey, signal) => requestModelListing(url, { 'x-api-key': apiKey }, signal),
    now: () => Date.now(),
    // ACP reserves stdout for protocol messages, including during successful catalog loads.
    info: (message) => { console.error(LOG_TAG, message) },
    warn: (message) => { console.warn(LOG_TAG, message) },
  })
  let reportedListing: ModelListing | undefined
  /** Resolve the catalog of one operation, reporting each listing's hidden entries once. */
  const connectionOf = (connection: ResolvedDeepSeekOptions, view: ListingView | undefined): OfficialConnection => {
    if (view === undefined) return { ...connection, offered: connection.models, refusals: new Map() }
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
    return { ...connection, models: catalog.resolution, offered: catalog.offered, refusals: catalog.refusals }
  }
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] },
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
    resolveAuth: async connection => ({ headers: { 'x-api-key': await resolveApiKey(connection) } }),
    admit: (connection, model) => { refuseListedModel(model, connection.refusals.get(model)) },
    discoverModels: async (provider) => {
      const connection = options()
      if (connection.listing === undefined) {
        if (await presentApiKey(connection) === undefined) return []
        return connection.models.map(model => catalogModelInfo(provider, model))
      }
      const view = await listings.view(connection.listing)
      return view.authenticated ? connectionOf(connection, view).offered.map(model => catalogModelInfo(provider, model)) : []
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
  ctx.effect(() => () => { listings.dispose() }, 'llm-deepseek-api-key: model listing')
}
