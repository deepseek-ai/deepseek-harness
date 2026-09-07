/**
 * Materialization of one provider route's model catalog. The installed pi-ai
 * catalog supplies defaults keyed by model id, and a profile's own model
 * entries override them field by field, so a route naming a catalog provider
 * stays configuration-free while a route pi-ai has never heard of is fully
 * describable from `settings.yaml`.
 *
 * Every pi-ai `Model` field the harness cannot default is required here rather
 * than at request time: an unserviceable route fails while its configuration is
 * being resolved, which is the earliest point that can name the offending key.
 *
 * @module dsh-llm-pi-ai/catalog
 */

import { builtinProviders, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type {
  AnthropicMessagesCompat,
  Api,
  BedrockCompat,
  ChatTemplateKwargValue,
  KnownApi,
  Model,
  ModelCost,
  ModelThinkingLevel,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  Provider,
  ThinkingLevelMap,
} from '@earendil-works/pi-ai'

/**
 * Pricing for a model the installed catalog does not describe. The harness
 * never reads pi-ai's cost metadata — `replay.ts` zeroes it and no consumer
 * reports spend — so this is the absence of a fact, not a configurable rate.
 */
const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** One request modality a pi-ai model may accept. */
export type PiAiModality = Model<Api>['input'][number]

/**
 * Every pi-ai request modality. The `Record` key type is a drift gate: a pi-ai
 * upgrade that adds or removes a modality fails compilation here naming the
 * drifted key, instead of silently narrowing what a profile may declare.
 */
const MODALITY_GATE: Record<PiAiModality, true> = {
  text: true,
  image: true,
}

/** Every request modality a profile may declare. */
export const MODALITIES = Object.keys(MODALITY_GATE) as readonly PiAiModality[]

/**
 * One entry's modality list, or `undefined` when it states no answer. Absent
 * and empty mean the same thing — `[]` describes a model that accepts nothing
 * and could serve no request — which is what makes an entry naming a catalog
 * model without declaring modalities keep the catalog's, since the config
 * schema materializes `[]` for an absent array.
 * @param configured - the list a `models` or `modelOverrides` entry supplied.
 * @returns the declared modalities, or `undefined` to ask the next level.
 */
function declaredInput(configured: readonly PiAiModality[] | undefined): Model<Api>['input'] | undefined {
  return configured === undefined || configured.length === 0 ? undefined : [...configured]
}

/**
 * Every pi-ai thinking level, in pi-ai's canonical escalation order. The
 * `Record` key type is a drift gate: a pi-ai upgrade that adds or removes a
 * level fails compilation here naming the drifted key, instead of silently
 * narrowing what a profile may declare.
 */
const THINKING_LEVEL_GATE: Record<ModelThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

/** Every pi-ai thinking level a profile may declare, in escalation order. */
export const THINKING_LEVELS = Object.keys(THINKING_LEVEL_GATE) as readonly ModelThinkingLevel[]

/** One reasoning-dispatch wire format a profile may name. */
export type PiAiThinkingFormat = NonNullable<OpenAICompletionsCompat['thinkingFormat']>

/**
 * The nameable reasoning-dispatch formats, most-reached first. The `Record`
 * key type is a drift gate: an upstream format addition fails compilation
 * here until it is named, so the offer never silently lags the upstream set.
 * The two `chat-template` variants are nameable because
 * {@link PiAiCompatProfile.chatTemplateKwargs} carries their kwargs;
 * `baseten` is nameable because {@link PiAiCompatProfile.chatTemplateArgs}
 * carries its arguments.
 */
const THINKING_FORMAT_GATE: Record<PiAiThinkingFormat, true> = {
  'openai': true,
  'deepseek': true,
  'openrouter': true,
  'together': true,
  'baseten': true,
  'zai': true,
  'qwen': true,
  'chat-template': true,
  'qwen-chat-template': true,
  'string-thinking': true,
  'ant-ling': true,
}

/** Reasoning-dispatch wire formats a profile may name, most-reached first. */
export const SUPPORTED_THINKING_FORMATS = Object.keys(THINKING_FORMAT_GATE) as readonly PiAiThinkingFormat[]

/** The output-cap field spellings pi-ai accepts. */
export type PiAiMaxTokensField = NonNullable<OpenAICompletionsCompat['maxTokensField']>

/** Drift gate over {@link PiAiMaxTokensField}; an upstream spelling added here fails compilation until named. */
const MAX_TOKENS_FIELD_GATE: Record<PiAiMaxTokensField, true> = {
  max_completion_tokens: true,
  max_tokens: true,
}

/** The output-cap field spellings a profile may name. */
export const MAX_TOKENS_FIELDS = Object.keys(MAX_TOKENS_FIELD_GATE) as readonly PiAiMaxTokensField[]

/** The reasoning-budget field spellings pi-ai accepts. */
export type PiAiThinkingTokenBudgetField = NonNullable<OpenAICompletionsCompat['thinkingTokenBudgetField']>

/** An upstream reasoning-budget spelling must be classified before it can be configured. */
const THINKING_TOKEN_BUDGET_FIELD_GATE: Record<PiAiThinkingTokenBudgetField, true> = {
  thinking_token_budget: true,
  thinking_budget: true,
  thinking_budget_tokens: true,
}

/** The reasoning-budget field spellings a profile may name. */
export const THINKING_TOKEN_BUDGET_FIELDS = Object.keys(THINKING_TOKEN_BUDGET_FIELD_GATE) as readonly PiAiThinkingTokenBudgetField[]

/** The prompt-cache marker conventions pi-ai accepts. */
export type PiAiCacheControlFormat = NonNullable<OpenAICompletionsCompat['cacheControlFormat']>

/** Drift gate over {@link PiAiCacheControlFormat}; a new upstream convention fails compilation until named. */
const CACHE_CONTROL_FORMAT_GATE: Record<PiAiCacheControlFormat, true> = {
  anthropic: true,
}

/** The prompt-cache marker conventions a profile may name. */
export const CACHE_CONTROL_FORMATS = Object.keys(CACHE_CONTROL_FORMAT_GATE) as readonly PiAiCacheControlFormat[]

/** The request-state placeholders a `chat_template_kwargs` value may name. */
export type PiAiChatTemplateVar = Extract<ChatTemplateKwargValue, { $var: string }>['$var']

/** Drift gate over {@link PiAiChatTemplateVar}; a new upstream placeholder fails compilation until named. */
const CHAT_TEMPLATE_VAR_GATE: Record<PiAiChatTemplateVar, true> = {
  'thinking.enabled': true,
  'thinking.effort': true,
  'thinking.budget': true,
}

/** The request-state placeholders a profile may name. */
export const CHAT_TEMPLATE_VARS = Object.keys(CHAT_TEMPLATE_VAR_GATE) as readonly PiAiChatTemplateVar[]

let providerIndex: Map<string, Provider> | undefined

/**
 * Installed catalog providers by id, constructed once. Each entry owns the API
 * implementations for its own models, which is why a catalog route reuses this
 * provider instead of being rebuilt from parts.
 * @returns the catalog provider index.
 */
function catalogProviders(): Map<string, Provider> {
  providerIndex ??= new Map(builtinProviders().map(provider => [provider.id, provider]))
  return providerIndex
}

/**
 * The installed catalog provider for one route, when pi-ai ships one.
 * @param provider - provider route key.
 * @returns the catalog provider, or `undefined` for a route pi-ai does not ship.
 */
export function catalogProvider(provider: string): Provider | undefined {
  return catalogProviders().get(provider)
}

/**
 * Every provider route the installed pi-ai catalog ships.
 * @returns the catalog provider ids.
 */
export function catalogProviderIds(): readonly string[] {
  return getBuiltinProviders()
}

/**
 * The installed catalog models for one route, indexed by model id.
 * @param provider - provider route key.
 * @returns catalog models by id; empty for a route pi-ai does not ship.
 */
export function catalogModels(provider: string): Map<string, Model<Api>> {
  if (!catalogProviders().has(provider)) return new Map()
  const models = getBuiltinModels(provider as BuiltinProvider) as Model<Api>[]
  return new Map(models.map(model => [model.id, model]))
}

/**
 * Selectable reasoning efforts for one model: each key is a level the model
 * offers (and selectors show), and its value is the wire spelling dispatch
 * sends for it. `off` alone may leave its value empty — "supported, send
 * nothing" — because for most providers not thinking is the parameter's
 * absence; every other declared level must name a wire value. A level absent
 * from the dict is not offered.
 */
export type PiAiReasoningEfforts = Partial<Record<ModelThinkingLevel, string | null>>

/**
 * Whether one pi-ai compat field is configurable on a profile.
 *
 * `withhold` is the disposition for a field pi-ai's installed catalog already
 * sets for a named vendor. Reaching for one of those on a hand-declared route
 * means configuring a provider that should have been named as a catalog route
 * instead, where the installed entry carries the right value already.
 */
type CompatDisposition = 'offer' | 'withhold'

/**
 * Disposition of every `OpenAICompletionsCompat` field. The `Record` key type
 * is a drift gate: a pi-ai upgrade that adds a field fails compilation here
 * until it is classified, so the offer never silently lags the upstream set.
 */
const COMPLETIONS_COMPAT_GATE = {
  supportsStore: 'offer',
  supportsDeveloperRole: 'offer',
  supportsReasoningEffort: 'offer',
  supportsUsageInStreaming: 'offer',
  supportsFinishReason: 'offer',
  maxTokensField: 'offer',
  requiresToolResultName: 'offer',
  requiresAssistantAfterToolResult: 'offer',
  requiresThinkingAsText: 'offer',
  requiresReasoningContentOnAssistantMessages: 'offer',
  thinkingFormat: 'offer',
  chatTemplateKwargs: 'offer',
  chatTemplateArgs: 'offer',
  supportsThinkingTokenBudget: 'offer',
  thinkingTokenBudgetField: 'offer',
  vllmPriority: 'offer',
  supportsStrictMode: 'offer',
  cacheControlFormat: 'offer',
  supportsLongCacheRetention: 'offer',
  openRouterRouting: 'withhold',
  vercelGatewayRouting: 'withhold',
  zaiToolStream: 'withhold',
  supportsOpenAIGrammarTools: 'withhold',
  sendSessionAffinityHeaders: 'withhold',
  deferredToolsMode: 'withhold',
  sessionAffinityFormat: 'withhold',
} as const satisfies Record<keyof OpenAICompletionsCompat, CompatDisposition>

/** Disposition of every `OpenAIResponsesCompat` field; a drift gate like the one above. */
const RESPONSES_COMPAT_GATE = {
  supportsDeveloperRole: 'offer',
  supportsMaxOutputTokens: 'offer',
  supportsStrictMode: 'offer',
  supportsLongCacheRetention: 'offer',
  sessionAffinityFormat: 'withhold',
  supportsOpenAIGrammarTools: 'withhold',
  supportsAdditionalTools: 'withhold',
  supportsToolSearch: 'withhold',
  supportsExplicitPromptCacheMode: 'withhold',
} as const satisfies Record<keyof OpenAIResponsesCompat, CompatDisposition>

/** Disposition of every `AnthropicMessagesCompat` field; a drift gate like the one above. */
const ANTHROPIC_COMPAT_GATE = {
  supportsEagerToolInputStreaming: 'offer',
  supportsLongCacheRetention: 'offer',
  supportsCacheControlOnTools: 'offer',
  supportsTemperature: 'offer',
  forceAdaptiveThinking: 'offer',
  allowEmptySignature: 'offer',
  supportsStrictTools: 'offer',
  sendSessionAffinityHeaders: 'withhold',
  supportsToolReferences: 'withhold',
  supportsMidConvoEffort: 'withhold',
  allowedFallbackModels: 'withhold',
} as const satisfies Record<keyof AnthropicMessagesCompat, CompatDisposition>

/** Disposition of every `BedrockCompat` field; a drift gate like the one above. */
const BEDROCK_COMPAT_GATE = {
  supportsStrictMode: 'offer',
} as const satisfies Record<keyof BedrockCompat, CompatDisposition>

/**
 * Every wire protocol pi-ai gives a compat type. Derived from `Model.compat`'s
 * own conditional rather than listed by hand, so a pi-ai release that gives a
 * further protocol a compat type fails the {@link COMPAT_GATES} entry list
 * until someone classifies its fields. A protocol pi-ai gives no compat type
 * resolves away here and takes no configured compat at all.
 */
type ApiWithCompat = { [K in KnownApi]: NonNullable<Model<K>['compat']> extends never ? never : K }[KnownApi]

/**
 * The compat gate of every wire protocol a profile may configure.
 *
 * Keyed by protocol, but grouped by pi-ai's compat *type*: the three Responses
 * protocols share `OpenAIResponsesCompat`, so a switch settable on one is
 * settable on all three. Keying by protocol alone would refuse
 * `azure-openai-responses` and `openai-codex-responses` the fields their own
 * models declare.
 */
const COMPAT_GATES: Readonly<Record<ApiWithCompat, Readonly<Record<string, CompatDisposition>>>> = {
  'openai-completions': COMPLETIONS_COMPAT_GATE,
  'openai-responses': RESPONSES_COMPAT_GATE,
  'azure-openai-responses': RESPONSES_COMPAT_GATE,
  'openai-codex-responses': RESPONSES_COMPAT_GATE,
  'anthropic-messages': ANTHROPIC_COMPAT_GATE,
  'bedrock-converse-stream': BEDROCK_COMPAT_GATE,
}

/**
 * The compat gate of one resolved protocol. A `string` lookup rather than a
 * keyed read: a route's `api` is configuration, so it may name a protocol
 * pi-ai gives no compat type — or none at all.
 * @param api - resolved wire protocol.
 * @returns that protocol's field gate, or `undefined` when it takes no compat.
 */
function compatGate(api: string): Readonly<Record<string, CompatDisposition>> | undefined {
  return (COMPAT_GATES as Readonly<Record<string, Readonly<Record<string, CompatDisposition>>>>)[api]
}

/** The field names one gate offers. */
type OfferedIn<G> = { [K in keyof G]: G[K] extends 'offer' ? K : never }[keyof G]

/** Every compat field name a profile may set, on whichever protocol takes it. */
type OfferedCompatField =
  | OfferedIn<typeof COMPLETIONS_COMPAT_GATE>
  | OfferedIn<typeof RESPONSES_COMPAT_GATE>
  | OfferedIn<typeof ANTHROPIC_COMPAT_GATE>
  | OfferedIn<typeof BEDROCK_COMPAT_GATE>

/**
 * pi-ai wire-compatibility switches, set on the route (its models' default) or
 * per model (winning over the route, field by field).
 *
 * pi-ai decides each of these from the provider id and baseURL when no layer
 * sets it, and a private gateway's URL says nothing: for an endpoint it does
 * not recognize the detection answers as though it were OpenAI itself, which
 * is wrong for most OpenAI-compatible gateways. So every field here is one a
 * deployment must be able to state because nothing can infer it, while the
 * fields pi-ai's catalog sets for a named vendor stay withheld.
 *
 * A field belongs to the protocols whose upstream compat type declares it: a
 * model-level switch its protocol does not take fails resolution, and a
 * route-level one skips past models it cannot fit. "The three Responses
 * protocols" below means `openai-responses`, `azure-openai-responses`, and
 * `openai-codex-responses`, which pi-ai gives one shared compat type, so a
 * switch settable on one is settable on all three.
 */
export interface PiAiCompatProfile {
  /** Whether the endpoint accepts `store`; `openai-completions`. */
  supportsStore?: boolean
  /**
   * Whether the endpoint accepts the `developer` role for the system prompt,
   * which pi-ai sends only to a reasoning model; `false` keeps `system`.
   * `openai-completions` and the three Responses protocols.
   */
  supportsDeveloperRole?: boolean
  /** Whether the endpoint accepts `reasoning_effort`; `openai-completions`. */
  supportsReasoningEffort?: boolean
  /** Whether the endpoint accepts `stream_options: {include_usage: true}`; `openai-completions`. */
  supportsUsageInStreaming?: boolean
  /**
   * Whether streams include `finish_reason`; `false` lets pi-ai infer the
   * terminal reason when the stream ends; `openai-completions`.
   */
  supportsFinishReason?: boolean
  /** Which output-cap field the endpoint reads; `openai-completions`. */
  maxTokensField?: NonNullable<OpenAICompletionsCompat['maxTokensField']>
  /** Whether tool results must carry `name`; `openai-completions`. */
  requiresToolResultName?: boolean
  /** Whether a user message after tool results needs an assistant message between; `openai-completions`. */
  requiresAssistantAfterToolResult?: boolean
  /** Whether thinking blocks must travel as text in `<thinking>` delimiters; `openai-completions`. */
  requiresThinkingAsText?: boolean
  /** Whether replayed assistant messages need an empty `reasoning_content` while reasoning is on; `openai-completions`. */
  requiresReasoningContentOnAssistantMessages?: boolean
  /** Reasoning parameter format the endpoint expects; `openai-completions`. */
  thinkingFormat?: PiAiThinkingFormat
  /**
   * Kwargs sent as `chat_template_kwargs`, which pi-ai reads only under the
   * two `chat-template` thinking formats; `openai-completions`. Nothing checks
   * that pairing: the format in force may come from the installed catalog
   * entry or from pi-ai's own baseURL detection, neither of which resolution
   * can read, so kwargs set beside another format are sent nowhere.
   */
  chatTemplateKwargs?: NonNullable<OpenAICompletionsCompat['chatTemplateKwargs']>
  /** Arguments sent as `chat_template_args` under the `baseten` thinking format; `openai-completions`. */
  chatTemplateArgs?: NonNullable<OpenAICompletionsCompat['chatTemplateArgs']>
  /** Alias for `thinkingTokenBudgetField: "thinking_token_budget"`; an explicit field wins. `openai-completions`. */
  supportsThinkingTokenBudget?: boolean
  /** Request field carrying the reasoning budget from `thinkingBudgets`; omitted unless configured. `openai-completions`. */
  thinkingTokenBudgetField?: PiAiThinkingTokenBudgetField
  /** vLLM scheduler `priority`; lower runs earlier, and the server must enable priority scheduling. Omitted unless configured. */
  vllmPriority?: number
  /** Whether `openai-responses` accepts `max_output_tokens`; `false` omits it. Azure and Codex ignore this shared compat field. */
  supportsMaxOutputTokens?: boolean
  /**
   * Whether the endpoint accepts `strict` in tool definitions;
   * `openai-completions`, the three Responses protocols, `bedrock-converse-stream`.
   */
  supportsStrictMode?: boolean
  /** Prompt-cache marker convention; `openai-completions`. */
  cacheControlFormat?: NonNullable<OpenAICompletionsCompat['cacheControlFormat']>
  /**
   * Whether the endpoint accepts long prompt-cache retention;
   * `openai-completions`, the three Responses protocols, `anthropic-messages`.
   */
  supportsLongCacheRetention?: boolean
  /** Whether the endpoint accepts per-tool `eager_input_streaming`; `anthropic-messages`. */
  supportsEagerToolInputStreaming?: boolean
  /** Whether the endpoint accepts `cache_control` on tool definitions; `anthropic-messages`. */
  supportsCacheControlOnTools?: boolean
  /** Whether the endpoint accepts the `temperature` request field; `anthropic-messages`. */
  supportsTemperature?: boolean
  /** Whether to force adaptive thinking regardless of model id; `anthropic-messages`. */
  forceAdaptiveThinking?: boolean
  /** Whether to replay an empty thinking signature instead of converting thinking to text; `anthropic-messages`. */
  allowEmptySignature?: boolean
  /** Whether the endpoint accepts Anthropic strict tool schemas; `anthropic-messages`. */
  supportsStrictTools?: boolean
}

/** Compile-time constraint that `T` is `never`. */
type AssertNever<T extends never> = T

/**
 * Proof that every documented field is one a gate offers. A field the profile
 * declares past the gates fails compilation with its own name in the error.
 */
export type EveryProfileFieldIsOffered = AssertNever<Exclude<keyof PiAiCompatProfile, OfferedCompatField>>

/**
 * Proof that every offered field is documented. A gate entry flipped to
 * `offer` without a profile field fails compilation with its own name in the
 * error, which is the half a schema alone cannot catch.
 */
export type EveryOfferedFieldIsDocumented = AssertNever<Exclude<OfferedCompatField, keyof PiAiCompatProfile>>

/** Compile-time constraint that `T` is `true`. */
type AssertTrue<T extends true> = T

/** Every compat type a gate classifies, merged so one `Pick` reaches all offered fields. */
type UpstreamCompat = OpenAICompletionsCompat & OpenAIResponsesCompat & AnthropicMessagesCompat & BedrockCompat

/**
 * Proof that each documented field carries its upstream type, not a hand-copied
 * restatement of it. The name gates above pin *which* fields exist; this pins
 * their types, in both directions because each catches a different drift. A
 * profile field wider than upstream accepts a value the provider rejects, and
 * `resolveModelCompat`'s cast to `ModelCompat` would hide it; a narrower one
 * refuses a value the provider accepts, which is how an upgrade that widens a
 * union would otherwise leave configuration silently behind.
 */
export type EveryProfileFieldMatchesUpstream = AssertTrue<
  PiAiCompatProfile extends Partial<Pick<UpstreamCompat, OfferedCompatField>>
    ? Partial<Pick<UpstreamCompat, OfferedCompatField>> extends PiAiCompatProfile ? true : false
    : false
>

/**
 * The compat entries a profile actually set.
 *
 * schemastery materializes an absent dict as `{}` — the behavior
 * `reasoningEfforts` works around with a union — so every parsed profile
 * carries both template-argument keys whether or not anyone wrote them. An
 * empty one states nothing here: it would send no arguments, which is exactly
 * what leaving the field out does, so absent and empty are the same request
 * and neither may make a route look like it configured a switch. A valueless
 * scalar is the other thing schemastery lets through, and it is refused by
 * {@link assertOfferedCompatFields} before this runs rather than filtered.
 * @param compat - the configured switches, when any.
 * @returns the entries carrying a value, in declaration order.
 */
function configuredCompatEntries(compat: PiAiCompatProfile | undefined): readonly (readonly [string, unknown])[] {
  return Object.entries(compat ?? {}).flatMap(([field, value]) => {
    const empty = typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value as object).length === 0
    return empty ? [] : [[field, value] as const]
  })
}

/**
 * The protocols offering one compat field, in {@link COMPAT_GATES} order.
 * @param field - configured compat field name.
 * @returns the protocols whose compat takes it; empty when none does, which
 *   is either a withheld field or a name no upstream compat type declares.
 */
function compatProtocols(field: string): readonly string[] {
  return Object.entries(COMPAT_GATES).flatMap(([api, gate]) => gate[field] === 'offer' ? [api] : [])
}

/**
 * The compat fields one protocol offers, for a diagnostic that has to show
 * what was available instead of the name that missed.
 * @param api - wire protocol.
 * @returns the offered field names, or an empty list for a protocol taking no compat.
 */
function offeredCompatFields(api: string): readonly string[] {
  return Object.entries(compatGate(api) ?? {}).flatMap(([field, disposition]) => disposition === 'offer' ? [field] : [])
}

/**
 * Every offered field name, deduplicated, for the one diagnostic that cannot
 * narrow by protocol: the vocabulary check runs before any protocol resolves,
 * which is what lets it refuse a misspelling on a route whose models would
 * never have reached the protocol that declares the intended field.
 * @returns the offered field names across every protocol, in gate order.
 */
function allOfferedCompatFields(): readonly string[] {
  const fields = new Set<string>()
  for (const api of Object.keys(COMPAT_GATES)) {
    for (const field of offeredCompatFields(api)) fields.add(field)
  }
  return [...fields]
}

/**
 * Reject a compat key no protocol offers. Runs before any protocol is
 * resolved, so a withheld field or a misspelling fails even on a route whose
 * models never reach the protocol that would have taken it — the alternative
 * being the silent drop that let an unreadable switch look applied.
 * @param provider - provider route key, for diagnostics.
 * @param site - the configuration site, for diagnostics.
 * @param compat - the configured switches, when any.
 * @throws Error naming the offending key.
 */
function assertOfferedCompatFields(
  provider: string,
  site: string,
  compat: PiAiCompatProfile | undefined,
): void {
  // Every key, not only the ones carrying a value: a withheld or undeclared
  // name is never in the schema, so schemastery cannot have materialized it —
  // whatever its value, a person wrote it and expects it to do something.
  for (const [field, value] of Object.entries(compat ?? {})) {
    // The name is judged before the value, so a withheld or misspelled key
    // written bare is refused for being that name rather than for being empty:
    // the other order sends someone to supply a value the key would be refused
    // with anyway.
    if (compatProtocols(field).length === 0) {
      const declared = Object.values(COMPAT_GATES).some(gate => gate[field] !== undefined)
      if (declared) {
        invalid(provider, `${site} sets compat "${field}", which is not configurable here: pi-ai's installed`
          + ' catalog sets it for the vendors that need it, so name that provider as the route instead')
      }
      invalid(provider, `${site} sets compat "${field}", which no wire protocol declares; the configurable`
        + ` switches are ${allOfferedCompatFields().join(', ')}`)
    }
    // A valueless key (`supportsDeveloperRole:`) survives schemastery, which
    // passes nullable data through before any member schema runs — the same
    // behavior `reasoningEfforts` documents — and a `cordis.yml` entry may
    // reach the same state through `!!js undefined`. Either way the key is
    // kept, so carrying it forward writes nothing over whatever the next layer
    // resolved, leaving pi-ai's `??` at its baseURL detection: the "written but
    // not applied" outcome this surface exists to refuse.
    if (value == null) {
      invalid(provider, `${site} sets compat "${field}" with no value; give it one, or remove the key to`
        + ' leave the field to the next layer — the installed catalog entry, then pi-ai\'s own detection')
    }
  }
}

/** One configured model entry: an id plus the catalog fields it overrides. */
export interface PiAiModelProfile {
  /** Model id sent to the provider and accepted by {@link GenerateOptions.model}. */
  id: string
  /** Display name for selectors; defaults to the catalog name, then the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /**
   * Maximum output tokens. Configuring one also makes it this model's
   * per-request default; a value inherited from the installed catalog, or the
   * route's fallback, is the model's capability and never becomes a request
   * default on its own.
   */
  maxTokens?: number
  /**
   * Request modalities this model accepts. Absent — or empty, which describes
   * a model that accepts nothing and so states no answer either — keeps the
   * installed catalog entry's modalities, then the route's `defaultInput`.
   * Declaring images is what makes a hand-declared vision model usable, and
   * declaring text alone corrects a catalog model whose gateway does not serve
   * what the catalog records. This is a claim about the endpoint, not a check
   * of it: nothing interrogates a gateway for what it accepts, so a model
   * claiming images its endpoint refuses is refused by the provider instead,
   * mid-turn.
   */
  input?: PiAiModality[]
  /**
   * Selectable reasoning efforts. Absent inherits the installed catalog
   * entry's capability (a hand-declared model has none and does not reason);
   * `false` declares a non-reasoning model, which is how a profile strips
   * reasoning from a catalog model its gateway cannot serve; a non-empty dict
   * declares the offered levels and their wire spellings.
   */
  reasoningEfforts?: false | PiAiReasoningEfforts
  /** pi-ai wire-compatibility switches for this model, winning over the route's per field; one its protocol does not declare is refused. */
  compat?: PiAiCompatProfile
}

/**
 * Customization of one installed catalog model, keyed by its id in the
 * route's `modelOverrides` dict — the same fields a `models` entry may set,
 * with the id living in the key. Unlike a `models` list, overrides leave the
 * rest of the catalog serving untouched, which is what makes "correct one
 * model, keep the other thirty-seven" a three-line edit.
 */
export type PiAiModelOverride = Omit<PiAiModelProfile, 'id'>

/** The route-level facts model materialization reads. */
export interface RouteCatalogRequest {
  /** Provider route key, stamped onto every materialized model. */
  provider: string
  /** Wire protocol override; absent defers to each catalog model's own API. */
  api?: string
  /** Endpoint override; absent defers to the catalog model, then the catalog provider. */
  baseURL?: string
  /** Configured catalog; absent means the whole installed catalog for this route. */
  models?: readonly PiAiModelProfile[]
  /** Installed-catalog customizations by model id; only meaningful while `models` is absent. */
  modelOverrides?: Readonly<Record<string, PiAiModelOverride>>
  /** Route-level wire-compatibility switches, landing on each model whose protocol declares them; entries override per field. */
  compat?: PiAiCompatProfile
  /** Context capacity for a model neither the entry nor the catalog sizes. */
  defaultContextWindow: number
  /** Output capability for a model neither the entry nor the catalog sizes. */
  defaultMaxTokens: number
  /** Modalities for a model neither the entry nor the catalog declares. */
  defaultInput: Model<Api>['input']
}

/** Report a route the deployment cannot serve, naming the settings key at fault. */
function invalid(provider: string, detail: string): never {
  throw new Error(`llm-pi-ai: provider "${provider}" ${detail}`)
}

/**
 * The one wire protocol a catalog route's shipped models agree on. This is what
 * lets a deployment add a model the installed catalog has not caught up with —
 * a provider's newest release — without restating the protocol its siblings
 * already use. A route whose shipped models disagree (an OpenAI-style catalog
 * spanning Responses and Chat Completions) has no such answer, so a model it
 * does not describe must name its protocol at the route.
 */
function sharedCatalogApi(defaults: ReadonlyMap<string, Model<Api>>): string | undefined {
  const apis = new Set<string>()
  for (const model of defaults.values()) apis.add(model.api)
  return apis.size === 1 ? [...apis][0] : undefined
}

/** The reasoning fields one materialized model carries. */
interface ModelReasoning {
  /** Whether the model reasons at all; `false` makes pi-ai ignore the map. */
  reasoning: boolean
  /** The map dispatch reads; absent only when the installed entry's (or none) applies. */
  thinkingLevelMap?: ThinkingLevelMap
}

/**
 * Resolve one model's reasoning capability from its declared efforts.
 *
 * A declared dict translates to pi-ai's `thinkingLevelMap` with every level
 * decided explicitly: declared levels carry their wire spelling, undeclared
 * levels are pinned to `null` (unsupported). Pinning matters because pi-ai's
 * own defaulting is asymmetric — an absent key means "supported" for the five
 * base levels but "unsupported" for `xhigh`/`max` — and a profile author
 * should not need to know that. A declared `off` with no value is the one
 * exception: it stays absent from the map, which pi-ai reads as "supported,
 * send nothing" — the correct dispatch where not thinking is the parameter's
 * absence — while `off` with a value sends that value.
 * @param provider - provider route key, for diagnostics.
 * @param entry - the configured model entry.
 * @param base - the installed catalog entry of the same id, when one exists.
 * @returns the reasoning fields the materialized model carries.
 */
function resolveModelReasoning(
  provider: string,
  entry: PiAiModelProfile,
  base: Model<Api> | undefined,
): ModelReasoning {
  const efforts = entry.reasoningEfforts
  if (efforts === undefined) {
    // Reasoning rides the installed entry or is absent: a bare capability flag
    // would make pi-ai advertise effort levels with no `thinkingLevelMap` to
    // spell them, and no listing endpoint reports a model's reasoning
    // protocol. The entry's map (when any) arrives through the `...base`
    // spread in the model literal.
    return { reasoning: base?.reasoning ?? false }
  }
  // The installed entry's map may ride along through `...base`; pi-ai never
  // reads it on a non-reasoning model, so stripping it is not worth a field
  // enumeration here.
  if (efforts === false) return { reasoning: false }
  // A YAML `reasoningEfforts:` left valueless arrives as null through the
  // schema union — outside the field's declared type, hence the widening —
  // while an explicit `{}` arrives as an empty dict. Both declare nothing,
  // and neither is a spelling of "inherit" or "disable".
  if ((efforts as unknown) === null || Object.keys(efforts).length === 0) {
    invalid(provider, `model "${entry.id}" has an empty reasoningEfforts; declare the offered levels, set`
      + ' false for a non-reasoning model, or omit the field to keep the installed catalog\'s capability')
  }
  const declared = THINKING_LEVELS.flatMap((level) => {
    const wire = efforts[level]
    return wire === undefined ? [] : [[level, wire] as const]
  })
  for (const [level, wire] of declared) {
    if (wire === null) {
      if (level !== 'off') {
        invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch`
          + ' should send; only "off" may leave it empty')
      }
    } else if (wire.length === 0) {
      invalid(provider, `model "${entry.id}" reasoningEfforts.${level} must not be an empty string`)
    }
  }
  if (!declared.some(([level]) => level !== 'off')) {
    invalid(provider, `model "${entry.id}" reasoningEfforts offers no level beyond "off"; declare a thinking`
      + ' level, or set reasoningEfforts to false for a non-reasoning model')
  }
  const map: ThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level]
    if (wire === undefined) {
      map[level] = null
    } else if (wire !== null) {
      map[level] = wire
    }
  }
  return { reasoning: true, thinkingLevelMap: map }
}

/** The compat block a materialized model carries, whichever protocol it speaks. */
type ModelCompat = OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | BedrockCompat

/**
 * Resolve one model's compat block from the profile's switches.
 *
 * A model switch wins over the route switch field by field; whatever neither
 * sets keeps the installed entry's value, and a field no layer decides falls
 * through to pi-ai's own detection. A model-level switch its protocol does not
 * take fails resolution — about one named model it can only be a mistake —
 * while a route-level one skips past such models, since a route default must
 * stay settable on a route whose models do not all speak one protocol. Every
 * field reaching here is offered by some protocol; {@link
 * assertOfferedCompatFields} has already refused the rest.
 * @param provider - provider route key, for diagnostics.
 * @param entry - the configured model entry.
 * @param route - the route-level switches, when any.
 * @param base - the installed catalog entry of the same id, when one exists.
 * @param api - the model's resolved wire protocol.
 * @returns a `compat` field to spread into the model, or nothing.
 */
function resolveModelCompat(
  provider: string,
  entry: PiAiModelProfile,
  route: PiAiCompatProfile | undefined,
  base: Model<Api> | undefined,
  api: string,
): { compat: ModelCompat } | Record<string, never> {
  const gate = compatGate(api)
  const configured: Record<string, unknown> = {}
  for (const [field, value] of configuredCompatEntries(route)) {
    if (gate?.[field] !== 'offer') continue
    configured[field] = value
  }
  for (const [field, value] of configuredCompatEntries(entry.compat)) {
    if (gate?.[field] !== 'offer') {
      const offered = offeredCompatFields(api)
      invalid(provider, `model "${entry.id}" sets compat "${field}", but its api is "${api}", which does not`
        + ` take it; that switch exists on ${compatProtocols(field).join(', ')}, and "${api}" offers`
        + ` ${offered.length === 0 ? 'no configurable compat' : offered.join(', ')}`)
    }
    configured[field] = value
  }
  if (Object.keys(configured).length === 0) return {}
  // The installed entry's compat matches the entry's OWN api — a route-level
  // `api` repoint (an anthropic catalog served through an OpenAI-compatible
  // gateway) leaves `base.compat` in the other protocol's shape, so it is
  // inherited only while the resolved api still is the entry's. A repointed
  // model starts from pi-ai's baseURL-derived detection instead, which is
  // what a protocol change means for every other compat field too.
  const inherited = base?.api === api ? base.compat : undefined
  return { compat: { ...inherited, ...configured } as ModelCompat }
}

/** One route's materialized catalog, plus the request caps its profile chose. */
export interface RouteCatalog {
  /** The materialized models in configuration order. */
  models: readonly Model<Api>[]
  /**
   * Per-request output caps this profile explicitly configured, by model id.
   *
   * Separate from `Model.maxTokens` because the two answer different
   * questions: pi-ai requires `maxTokens` as the model's output *capability*,
   * while the harness seam's `defaultMaxTokens` is a cap the deployment chose
   * to send on requests that name none. Materializing a catalog capability as
   * a request default would start capping every request at a number nobody
   * picked, so only an explicit configuration lands here.
   */
  configuredMaxTokens: ReadonlyMap<string, number>
}

/**
 * Materialize one route's catalog by merging the installed catalog defaults
 * under the configured entries. A route with no configured `models` serves the
 * installed catalog unchanged, which is what keeps an existing
 * `providers: { deepseek: { apiKeyEnv: … } }` profile working untouched.
 * @param request - the route-level catalog facts.
 * @returns the materialized models and the explicitly configured request caps.
 */
export function resolveRouteModels(request: RouteCatalogRequest): RouteCatalog {
  const { provider } = request
  const defaults = catalogModels(provider)
  const providerBaseUrl = catalogProvider(provider)?.baseUrl
  // An absent `models` key and an empty one are the same request: the config
  // schema materializes `[]` for the absent case, and an empty catalog could
  // serve no request anyway, so both mean "serve the installed catalog".
  const configured = request.models ?? []
  const overrides = request.modelOverrides ?? {}
  // Every miss is refused, never skipped: an override that lands nowhere is a
  // typo someone would otherwise hunt for in a silently unchanged model.
  for (const [id, override] of Object.entries(overrides)) {
    if (id.length === 0) invalid(provider, 'has a modelOverrides entry with an empty model id')
    if (defaults.size === 0) {
      invalid(provider, `sets modelOverrides for "${id}", but the installed catalog does not describe this route;`
        + ' a declared route spells every model out in its models list')
    }
    if (configured.length > 0) {
      invalid(provider, `sets modelOverrides for "${id}" beside a models list; models already replaces the served`
        + ' catalog, so declare the fields on its entries')
    }
    if (!defaults.has(id)) {
      invalid(provider, `modelOverrides names "${id}", which the installed catalog does not describe`)
    }
    // The id lives in the dict key; a value carrying its own would quietly
    // rename the model it meant to customize. The static shape already omits
    // it — this guards the schema boundary, which passes unknown keys through.
    if ('id' in override) {
      invalid(provider, `modelOverrides entry "${id}" sets "id", which is the dict key`)
    }
  }
  // An override becomes the catalog entry's configuration, so everything a
  // models entry may declare — capacities, efforts, compat — resolves through
  // the same path with the same diagnostics and request-default semantics.
  const entries: readonly PiAiModelProfile[] = configured.length > 0
    ? configured
    : [...defaults.values()].map(model => ({ id: model.id, ...overrides[model.id] }))
  if (entries.length === 0) {
    invalid(provider, 'resolves no models; the installed catalog does not describe this route, so its models'
      + ' must be listed in configuration')
  }
  const routeApi = sharedCatalogApi(defaults)
  // Vocabulary before protocols: a withheld or undeclared switch is refused
  // wherever it is written, so it cannot look applied on a route whose models
  // never reach the protocol that would have taken it.
  assertOfferedCompatFields(provider, 'route', request.compat)
  for (const entry of entries) {
    assertOfferedCompatFields(provider, `model "${entry.id}"`, entry.compat)
  }
  const seen = new Set<string>()
  const configuredMaxTokens = new Map<string, number>()
  const models = entries.map((entry) => {
    if (entry.id.length === 0) invalid(provider, 'has a model with an empty id')
    if (seen.has(entry.id)) invalid(provider, `lists model "${entry.id}" more than once`)
    seen.add(entry.id)
    const base = defaults.get(entry.id)
    const api = request.api ?? base?.api ?? routeApi
    if (api === undefined) {
      invalid(provider, `model "${entry.id}" needs an api; the installed catalog does not describe it, so set the`
        + ' route\'s api to the wire protocol its endpoint speaks')
    }
    const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl
    if (baseUrl === undefined) {
      invalid(provider, `model "${entry.id}" needs a baseURL; the installed catalog does not describe this route`)
    }
    // Capacities fall back to the route's own defaults, so a model listing that
    // discloses nothing but ids still yields a serviceable route. The fallback
    // is a guess by construction, which is why it is a configurable route field
    // rather than a constant buried here.
    const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`)
    }
    const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      invalid(provider, `model "${entry.id}" maxTokens must be a positive integer`)
    }
    // Only a value the profile named is a deployment choice; the catalog's is
    // the model's capability and stays out of request defaults.
    if (entry.maxTokens !== undefined) configuredMaxTokens.set(entry.id, entry.maxTokens)
    return {
      // The installed entry lays the floor, and the fields below override it.
      // Enumerating instead would silently drop every `Model` field this
      // package does not model — reasoning-level spellings, compatibility
      // quirks, model headers, and whatever a pi-ai upgrade adds next. Spread,
      // never enumerate.
      ...base,
      id: entry.id,
      name: entry.name ?? base?.name ?? entry.id,
      api,
      provider,
      baseUrl,
      input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput],
      cost: base?.cost ?? NO_COST,
      contextWindow,
      maxTokens,
      ...resolveModelReasoning(provider, entry, base),
      ...resolveModelCompat(provider, entry, request.compat, base, api),
    }
  })
  // Per field, not per block: a route may default a switch its completions
  // models take beside one only its anthropic models do, and neither should
  // fail for the other's sake. What is refused is a route default no model on
  // the route could ever read, which is a route that will not behave as written.
  for (const [field] of configuredCompatEntries(request.compat)) {
    const takers = compatProtocols(field)
    if (models.some(model => takers.includes(model.api))) continue
    invalid(provider, `sets compat "${field}", but no model on the route speaks a protocol that takes it;`
      + ` it exists on ${takers.join(', ')}`)
  }
  return { models, configuredMaxTokens }
}
