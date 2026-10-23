/** Account-token authentication, the account model listing, and version gating for the DeepSeek account route. */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, APP_IDENTITY, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  catalogModelInfo, ModelListingCache, refuseListedModel, registerDeepSeekProvider, requestModelListing, resolveAdapterOptions,
  resolveListedCatalog,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekRequestAuth, ListedCatalog, ListingView, ModelListing, ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { Config, plainAccountOptions, resolveAccountOptions } from './config.ts'

export { Config } from './config.ts'
export const name = 'llm-deepseek-account'
export const inject = ['llm']

const PROVIDER = 'deepseek-account'
/** Header carrying the account token on Messages, Files, and model-listing requests. */
const TOKEN_HEADER = 'x-dsh-auth-token'
/** Console tag of listing diagnostics; product profiles mount no console exporter for `ctx.logger`. */
const LOG_TAG = '[llm-deepseek-account]'

/** Connection facts of one account operation: protocol settings plus the catalog resolved with them. */
interface AccountConnection extends ResolvedDeepSeekOptions {
  readonly catalog: ListedCatalog
}

export function apply(ctx: Context, config: Config): void {
  const environment = launchEnvironmentOf(ctx)
  const settings = () => resolveAccountOptions(plainAccountOptions(config), environment)
  settings()
  const supported = resolveAdapterOptions({}).models
  const account = () => ctx.get('deepseekAccount')
  const resolveAuth = async (connection: ResolvedDeepSeekOptions): Promise<DeepSeekRequestAuth> => {
    const token = await account()?.resolveToken(connection.baseURL)
    if (token === undefined) throw new LlmError('Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.', 'ACCOUNT_SIGN_IN_REQUIRED')
    return {
      headers: { [TOKEN_HEADER]: token },
      onRequestError: async (error) => {
        if (!(error instanceof LlmError)) return error
        if (error.code === QUOTA_EXCEEDED_CODE) {
          return new LlmError(error.message, ACCOUNT_QUOTA_EXCEEDED_CODE, { ...error.failure, cause: error })
        }
        if (error.failure.status !== 401) return error
        const rejected = new LlmError(error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
        try { await account()?.rejectToken(token) }
        catch (_credentialRemovalFailed) { /* Storage failure cannot replace the inference failure. */ }
        return rejected
      },
    }
  }
  const catalog = new ModelListingCache({
    credential: async url => account()?.resolveToken(url),
    load: (url, token, signal) => requestModelListing(url, { [TOKEN_HEADER]: token }, signal),
    now: () => Date.now(),
    // ACP reserves stdout for protocol messages, including during successful catalog loads.
    info: (message) => { console.error(LOG_TAG, message) },
    warn: (message) => { console.warn(LOG_TAG, message) },
  })
  let loggedListing: ModelListing | undefined
  /** Resolve the catalog for one view, logging the listing's hidden entries once per listing. */
  const connectionOf = (view: ListingView): AccountConnection => {
    const resolved = settings()
    const result = resolveListedCatalog({
      listing: view.listing?.entries,
      supported,
      overrides: resolved.modelOverrides,
      routeMaxTokens: resolved.protocol.maxTokens,
      clientVersion: APP_IDENTITY.version,
    })
    if (view.listing !== loggedListing) {
      loggedListing = view.listing
      for (const problem of result.problems) console.warn(LOG_TAG, problem)
    }
    return { ...resolved.protocol, models: result.resolution, catalog: result }
  }
  const entry = { provider: PROVIDER, displayName: 'DeepSeek Account', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] }
  const directory = ctx.llm.registerConfigurableProviders([entry])
  let reportedError: string | undefined
  /** Publish override diagnostics on the provider directory. */
  const discovered = (view: ListingView): AccountConnection => {
    const connection = connectionOf(view)
    const error = connection.catalog.overrideErrors.length === 0 ? undefined : connection.catalog.overrideErrors.join('; ')
    if (error !== reportedError) {
      reportedError = error
      directory.replace([error === undefined ? entry : { ...entry, error }])
    }
    return connection
  }
  registerDeepSeekProvider<AccountConnection>(ctx, PROVIDER, {
    providerName: 'DeepSeek Account',
    options: () => connectionOf(catalog.current()),
    connect: async signal => connectionOf(await catalog.view(settings().catalog, signal)),
    resolveAuth,
    admit: (connection, model) => { refuseListedModel(model, connection.catalog.refusals.get(model)) },
    discoverModels: async (provider) => {
      const view = await catalog.view(settings().catalog)
      return view.authenticated ? discovered(view).catalog.offered.map(model => catalogModelInfo(provider, model)) : []
    },
  })
  ctx.effect(() => () => { catalog.dispose() }, 'llm-deepseek-account: model catalog')
}
