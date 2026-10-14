/** The account catalog: version gating, this build's model knowledge, and deployment overrides. */
import semver from 'semver'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelOverride } from './config.ts'
import type { ListedFacts, ListingEntry } from './listing.ts'

/** Why this build refuses one listed model before network I/O. */
export type CatalogRefusal =
  | { readonly kind: 'upgrade-required'; readonly requiredVersion: string }
  | { readonly kind: 'unsupported' }

/** Inputs of one catalog resolution. */
export interface AccountCatalogInput {
  /** Entries of the last successful listing, or `undefined` before one succeeds. */
  readonly listing: readonly ListingEntry[] | undefined
  /** Validated models this build supports, carrying its client-side knowledge. */
  readonly supported: readonly DeepSeekCatalogModel[]
  /** Overrides by model id, holding only the fields each one declares. */
  readonly overrides: Readonly<Record<string, ModelOverride>>
  /** Route output cap that a listed output capability bounds. */
  readonly routeMaxTokens: number
  /** This build's semantic version. */
  readonly clientVersion: string
}

/** One resolved account catalog. */
export interface AccountCatalog {
  /** Selectable models in listing order, or this build's models when no listing succeeded. */
  readonly offered: readonly DeepSeekCatalogModel[]
  /** Entries request resolution consults: offered models, then supported models the listing does not offer. */
  readonly resolution: readonly DeepSeekCatalogModel[]
  /** Listed models refused before network I/O, by id. */
  readonly refusals: ReadonlyMap<string, CatalogRefusal>
  /** Listing entries hidden because their declarations are unreadable or unusable. */
  readonly problems: readonly string[]
  /** Configuration diagnostics for `modelOverrides`. */
  readonly overrideErrors: readonly string[]
}

/** Replace fields of an entry; a text-only result drops the image limits it inherited. */
function layered(model: DeepSeekCatalogModel, layer: ModelOverride): DeepSeekCatalogModel {
  const merged: DeepSeekCatalogModel = { ...model, ...layer }
  if (merged.inputModalities?.includes('image') !== true) {
    if (layer.imagePixelBudget === undefined) delete merged.imagePixelBudget
    if (layer.imageMaxBytes === undefined) delete merged.imageMaxBytes
  }
  return merged
}

/** Layer one usable listing entry over this build's entry for the same id. */
function listed(base: DeepSeekCatalogModel, entry: ListingEntry, facts: ListedFacts, routeMaxTokens: number): DeepSeekCatalogModel {
  const { systemPromptUpdate: _replaced, ...leadingOnly } = base
  return layered(facts.systemPromptUpdate === 'leading-only' ? leadingOnly : base, {
    ...entry.name === undefined ? {} : { name: entry.name },
    ...facts.contextWindow === undefined ? {} : { contextWindow: facts.contextWindow },
    ...facts.maxOutputTokens === undefined ? {} : { maxTokens: Math.min(routeMaxTokens, facts.maxOutputTokens) },
    ...facts.systemPromptUpdate === 'in-history' ? { systemPromptUpdate: 'in-history' as const } : {},
    inputModalities: [...facts.inputModalities],
  })
}

function gateOf(entry: ListingEntry, known: boolean, clientVersion: string, problems: string[]): CatalogRefusal | undefined {
  const requirement = entry.requirement
  switch (requirement.kind) {
    case 'none':
      return known ? undefined : { kind: 'unsupported' }
    case 'min-version':
      if (semver.valid(requirement.version) === null) break
      return semver.gte(clientVersion, requirement.version)
        ? undefined
        : { kind: 'upgrade-required', requiredVersion: requirement.version }
    case 'invalid':
      break
    /* v8 ignore next 2 -- listing decoding produces only the closed requirement union */
    default:
      return assertNever(requirement, 'model listing client requirement')
  }
  problems.push(`model "${entry.id}" declares an unreadable client requirement`)
  return { kind: 'unsupported' }
}

/**
 * Resolve the account catalog. A declared minimum client version decides a
 * listed model's availability; without one, only models this build supports
 * are offered and the other listed models stay hidden.
 * @param input - listing, supported models, overrides, route cap, and this build's version.
 * @returns offered models, request-resolution entries, refusals, and diagnostics.
 */
export function resolveAccountCatalog(input: AccountCatalogInput): AccountCatalog {
  const supported = new Map(input.supported.map(model => [model.id, model]))
  const problems: string[] = []
  const overrideErrors: string[] = []
  const withOverride = (model: DeepSeekCatalogModel): DeepSeekCatalogModel => {
    const override = input.overrides[model.id]
    if (override === undefined) return model
    const candidate = layered(model, override)
    try {
      resolveAdapterOptions({ models: [candidate] })
    } catch (error) {
      overrideErrors.push(`modelOverrides.${model.id} does not apply (${String(error)})`)
      return model
    }
    return candidate
  }
  if (input.listing === undefined) {
    const resolution = resolveAdapterOptions({ models: input.supported.map(withOverride) }).models
    return { offered: resolution, resolution, refusals: new Map(), problems, overrideErrors }
  }
  const offered: DeepSeekCatalogModel[] = []
  const refusals = new Map<string, CatalogRefusal>()
  for (const entry of input.listing) {
    const refusal = gateOf(entry, supported.has(entry.id), input.clientVersion, problems)
    if (refusal !== undefined) {
      refusals.set(entry.id, refusal)
      continue
    }
    if (!entry.capabilities.usable) {
      problems.push(`model "${entry.id}" ${entry.capabilities.reason}`)
      refusals.set(entry.id, { kind: 'unsupported' })
      continue
    }
    offered.push(withOverride(listed(supported.get(entry.id) ?? { id: entry.id }, entry, entry.capabilities.facts, input.routeMaxTokens)))
  }
  const offeredIds = new Set(offered.map(model => model.id))
  const listedIds = new Set(input.listing.map(entry => entry.id))
  for (const id of Object.keys(input.overrides)) {
    if (!listedIds.has(id) && !supported.has(id)) {
      overrideErrors.push(`modelOverrides names "${id}", which neither the account listing nor the built-in catalog describes`)
    }
  }
  const resolution = resolveAdapterOptions({
    models: [...offered, ...input.supported.filter(model => !offeredIds.has(model.id)).map(withOverride)],
  }).models
  return { offered: resolution.slice(0, offered.length), resolution, refusals, problems, overrideErrors }
}
