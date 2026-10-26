/** Account route configuration: Messages settings, the model-listing endpoint, and per-model overrides. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  catalogModelFields, deepSeekConfigFields, modelListingConfigFields, modelListingURL, resolveAdapterOptions, resolveListingTiming,
} from '@deepseek-ai/dsh-llm-deepseek'
import type {
  Config as ProtocolConfig, ListingSettings, ModelListingConfig, ModelListingOptions, ModelOverride, Options as ProtocolOptions,
  ResolvedDeepSeekOptions,
} from '@deepseek-ai/dsh-llm-deepseek'

/** Account route configuration; authentication comes exclusively from the account service. */
export interface Config extends Omit<ProtocolConfig, 'models'>, ModelListingConfig {
  /** Field overrides by model id, layered over the account listing and the built-in catalog. */
  modelOverrides: Volatile<Record<string, ModelOverride>>
}

const { models: _protocolCatalog, ...protocolFields } = deepSeekConfigFields

const modelOverride: z<ModelOverride> = z.object({
  ...catalogModelFields,
  // No default, unlike a models entry: an absent list materializes as [], which reads as inherited.
  inputModalities: z.array(z.union(['text', 'image'] as const)),
})

export const Config = z.object({
  ...protocolFields,
  ...modelListingConfigFields,
  modelOverrides: z.dict(modelOverride).default({}).volatile(),
})

/** Plain account options accepted by {@link resolveAccountOptions}. */
export type AccountOptions = Omit<ProtocolOptions, 'models'> & ModelListingOptions & {
  modelOverrides?: Record<string, ModelOverride>
}

/** One validated configuration generation of the account route. */
export interface ResolvedAccountOptions {
  /** Messages settings; request resolution replaces `models` with the resolved account catalog. */
  readonly protocol: ResolvedDeepSeekOptions
  /** Listing endpoint and cache timing. */
  readonly catalog: ListingSettings
  /** Overrides by model id, holding only the fields each one declares. */
  readonly modelOverrides: Readonly<Record<string, ModelOverride>>
}

/**
 * Read the current value behind every reference of a validated Config.
 * @param config - parsed plugin Config.
 * @returns plain options for {@link resolveAccountOptions}.
 */
export function plainAccountOptions(config: Config): AccountOptions {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
}

/** Keep an override's declared fields: parsed configuration carries unset fields as `undefined` and unset arrays as `[]`. */
function resolveOverride(id: string, override: Readonly<Record<string, unknown>>): ModelOverride {
  if (id.length === 0) throw new Error('llm-deepseek-account: modelOverrides keys must be non-empty model ids')
  if (Object.hasOwn(override, 'id')) throw new Error(`llm-deepseek-account: modelOverrides.${id} sets "id", which is its key`)
  const declared: ModelOverride = {}
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue
    Reflect.set(declared, key, value)
  }
  try {
    // Cross-field rules also involve the entry an override meets once a listing loads,
    // so an image-capable stand-in checks each declared field here.
    resolveAdapterOptions({ models: [{ inputModalities: ['text', 'image'], ...declared, id }] })
  } catch (error) {
    throw new Error(`llm-deepseek-account: modelOverrides.${id} is invalid: ${String(error)}`, { cause: error })
  }
  return declared
}

/**
 * The one explicit resolve step from raw account settings to validated facts.
 * Settings updates can reach it without schema validation, so every bound is judged here.
 * @param options - plain account options.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns Messages settings, listing settings, and validated overrides.
 */
export function resolveAccountOptions(options: AccountOptions, environment?: LaunchEnvironmentSnapshot): ResolvedAccountOptions {
  if (Object.hasOwn(options, 'models')) {
    throw new Error('llm-deepseek-account: models is no longer configurable; the account /models listing supplies the catalog. '
      + 'Remove models from this entry and adjust single models with modelOverrides.<model id>')
  }
  const { modelsTimeoutMs: _timeout, modelsMaxAgeMs: _maxAge, modelOverrides = {}, ...protocolOptions } = options
  const timing = resolveListingTiming(options, 'llm-deepseek-account')
  const protocol = resolveAdapterOptions(protocolOptions, environment)
  return {
    protocol,
    catalog: { url: modelListingURL(protocol.baseURL), ...timing },
    modelOverrides: Object.fromEntries(Object.entries(modelOverrides).map(([id, override]) => [id, resolveOverride(id, override)])),
  }
}
