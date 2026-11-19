/**
 * Registry for ordered system sections, dynamic context, tool schemas, and prompt variables.
 *
 * @module @deepseek-ai/dsh-system-prompt
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer, Scoped } from '@deepseek-ai/dsh-scope'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotSection, SystemMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Session, SurfaceIntent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { assembleSystemAdmission, assertDistinctSections } from './admission.ts'
import { sectionAdmissionsDefinition } from './projection.ts'
import type { RenderedSection } from './admission.ts'
import type { SectionAdmissions } from './projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }

  interface Events {
    /**
     * Presentation waterfall over assembled sections, contexts, and variables.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only that scope's assemblies. Returned section text determines updates;
     * omitting a previously admitted section leaves its instructions unchanged.
     * Empty text withdraws its instructions; registration disposal retires it.
     * Tool declarations remain provider-owned.
     * A supplied signal controls only this explicit assembly request and must not
     * be retained to control later turns. A registered complete section is
     * restored after this waterfall, so listeners cannot add to or replace
     * that scope's system prompt.
     * @param assembly - the mutable assembly built from registered providers.
     * @param context - the caller's per-assembly context.
     * @mode waterfall
     */
    'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptPresentation, context: AssembleContext, next: () => Promise<PromptPresentation>): Promise<PromptPresentation>
    /**
     * Emitted when any prompt provider changes. This registry notification is
     * unfiltered because a global change affects every scope.
     * @mode emit
     */
    'system-prompt/change'(): void
  }
}

/** Merge-extensible context for one prompt assembly. */
export interface AssembleContext {
  /** Session receiving system updates; omission produces a registry-only presentation. */
  session?: Session
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal
}

/** One contributed section of the system prompt (registry input). */
export interface PromptSection {
  /** Logical source name; the nearest scope and latest registration in that scope win. */
  readonly name: string
  /**
   * Sections are concatenated in ascending order. Equal orders use code-unit
   * name order.
   */
  readonly order: number
  /**
   * Static text or a provider evaluated with that assembly's {@link AssembleContext}
   * only while this registration is effective. The text may reference `{{variable}}`s — they are
   * interpolated later unless `interpolate` is false, then trimmed before rendering
   * and admission. Interior whitespace is preserved.
   */
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  readonly interpolate?: boolean
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * Admission appends prospective supersession notices on entry, changes,
   * and exit; earlier messages retain their positions until compaction.
   * More than one effective complete section makes assembly fail.
   */
  readonly complete?: boolean
  /** Optional trimmed notice before changed text; blank text suppresses this notice. */
  readonly replacement?: string
  /**
   * Literal notice, nonempty after trimming, sent when no visible registration remains
   * to Sessions that previously admitted this name. The last disposed definition captured
   * by the Session supplies the notice; omission uses a notice naming the section.
   * A remaining or newly registered definition is compared as ordinary source text.
   */
  readonly retirement?: string
}

/**
 * Live Cordis registration shared with the Sessions that captured its definition.
 * Disposal order selects the final retirement notice when all captured owners leave.
 */
interface SectionRegistration {
  readonly definition: PromptSection
  /** Undefined while live; otherwise the service-local disposal order. */
  disposedAt?: number
}

/** Dynamic model context materialized as a durable user-role snapshot. */
export interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string
  /** Contexts are joined in ascending order. */
  readonly order: number
  /** Static text or a provider evaluated at assembly and admission refresh. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  readonly interpolate?: boolean
  /** Keep this operational context when optional runtime context is disabled. */
  readonly required?: boolean
}

/** One section of an assembly: {@link PromptSection} with its text resolved. */
export interface AssembledSection {
  /** This contribution exclusively supersedes earlier system-prompt sections from admission onward. */
  complete?: boolean
  /** Notice preceding an ordinary update to this section. */
  replacement?: string
  /** This literal text retires a disposed registration. */
  retire?: boolean
  /** Placement retained for canonical history reconstruction. */
  order: number
  /** The contributing section's unique name. */
  name: string
  /** The resolved (but not yet interpolated) section text. */
  text: string
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  interpolate?: boolean
}

/** One resolved dynamic context contribution. */
export interface AssembledContext {
  /** The contributing context's unique name. */
  name: string
  /** The resolved text before variable interpolation. */
  text: string
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  interpolate?: boolean
}

/** Tool schemas visible in one assembly and their pre-restriction name set. */
export interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}

/**
 * Prompt text contributions that the assembly waterfall may transform.
 * Sections and contexts remain uninterpolated until rendered; tool
 * declarations are owned by their providers.
 */
export interface PromptPresentation {
  sections: AssembledSection[]
  contexts: AssembledContext[]
  variables: Record<string, string | undefined>
}

/** One `system/message` write that admits captured sections into a Session. */
export interface SystemUpdate {
  readonly message: SystemMessage
  readonly intent: SurfaceIntent<'system/message'>
}

/** Completed model inputs: the presentation plus tool declarations in canonical order. */
export interface PromptAssembly extends PromptPresentation {
  /**
   * Compare the captured sections with the Session's committed state at the time of the call.
   * Append the returned writes in order, without yielding, before each model attempt.
   * A retry returns only the rebuild that compaction requires; an assembly without a Session returns none.
   * @param retry - whether an earlier attempt of the step already committed this assembly.
   */
  systemUpdates: (retry: boolean) => readonly SystemUpdate[]
  tools: ToolSchema[]
}

const SECTION_ORDERS = {
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500,
  TEAM_POLICY: 600,
  PTC_ONLY: 800,
  FILE_REFERENCE: 900,
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_APPLY_PATCH: 1350,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  TOOL_JOBS: 1600,
  TOOL_PTY: 1700,
  TOOL_PTY_PANEL: 1710,
  TOOL_WEB_SEARCH: 2000,
  TOOL_WEB_FETCH: 2100,
  TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300,
  TOOL_GOAL: 2400,
  TOOL_SCHEDULE: 2500,
  TOOL_WORKFLOW: 2600,
  TOOL_RALPH: 2700,
  TOOL_SUBAGENT: 2800,
  TOOL_REPORT: 2900,
  TOOL_COMPUTER_USE: 3000,
  MCP_SERVERS: 3100,
  TOOLS_SDK: 5000,
  DELIVERABLE_FILE_REFERENCES: 9000,
  STRUCTURED_OUTPUT: 9900,
  // Local paths and endpoints follow reusable instructions.
  HARNESS_SOURCE: 10000,
  WEB_SURFACE: 10100,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
} as const

/** Name of a centrally allocated prompt-section position. */
export type PromptSectionOrderName = keyof typeof SECTION_ORDERS

const CONTEXT_ORDERS = {
  WORKING_DIRECTORY: 100,
  SANDBOX_POLICY: 110,
  APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120,
  // Process-specific paths and endpoints stay out of the cached system prompt.
  HARNESS_SOURCE: 200,
  WEB_SURFACE: 210,
  PLUGIN_CLIS: 220,
} as const

/** Name of a centrally allocated runtime-context position. */
export type PromptContextOrderName = keyof typeof CONTEXT_ORDERS

/** Persona prefix name for deployment defaults and ordinary scoped section overrides. */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** Persona suffix name for deployment defaults and independent scoped section overrides. */
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/** Valid variable names: how they are written between the braces. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** A complete `{{...}}` reference group at the scan position (validated after). */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** Reserved {@link Config.toolOrder} marker for unlisted tools. */
export const TOOL_ORDER_REST = '<unlisted-tools>'

/**
 * Validate duplicate names and the required {@link TOOL_ORDER_REST} marker.
 * Registered names are checked later because plugins have not loaded yet.
 */
function validateToolOrder(toolOrder: string[] | undefined): string[] | undefined {
  if (toolOrder === undefined) return undefined
  const seen = new Set<string>()
  for (const name of toolOrder) {
    if (seen.has(name)) throw new Error(`toolOrder lists "${name}" more than once`)
    seen.add(name)
  }
  if (!seen.has(TOOL_ORDER_REST)) {
    throw new Error(`toolOrder must contain the "${TOOL_ORDER_REST}" rest entry (where unlisted tools are inserted)`)
  }
  return toolOrder
}

/**
 * Apply configured tool order, inserting unlisted tools lexicographically at
 * {@link TOOL_ORDER_REST}. Unknown configured names fail; known but restricted
 * names may be absent.
 */
function orderTools(tools: ToolSchema[], toolOrder: string[] | undefined, knownNames: ReadonlySet<string>): ToolSchema[] {
  const reserved = tools.find(tool => tool.name === TOOL_ORDER_REST)
  if (reserved !== undefined) {
    throw new Error(`tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`)
  }
  if (toolOrder === undefined) return tools.sort(compareToolNames)
  const unknown = toolOrder.filter(name => name !== TOOL_ORDER_REST && !knownNames.has(name))
  if (unknown.length > 0) {
    throw new Error(`toolOrder lists unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}; known tools: ${[...knownNames].sort().join(', ') || '(none)'}`)
  }
  const listed = new Set(toolOrder)
  const rest = tools.filter(tool => !listed.has(tool.name)).sort(compareToolNames)
  return toolOrder.flatMap(name =>
    name === TOOL_ORDER_REST ? rest : tools.filter(tool => tool.name === name))
}

/** Code-unit name comparison — locale-independent, so the order is identical on every machine. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Order prompt sections by their explicit placement, then deterministically by name. */
function comparePromptSections(a: PromptSection, b: PromptSection): number {
  return a.order - b.order || compareNames(a.name, b.name)
}

/** Order tool schemas lexicographically by name. */
function compareToolNames(a: ToolSchema, b: ToolSchema): number {
  return compareNames(a.name, b.name)
}

/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.personaPrefix} for its contract). */
export interface Config {
  /** Include the fixed DeepSeek Harness identity before the deployment persona (default true). */
  includeHarnessIdentity?: boolean
  /** Include optional runtime-context snapshots in model history (default true); required context remains. */
  includeRuntimeContext?: boolean
  /**
   * Deployment-wide persona prefix template before first-party guidance. A section
   * named {@link PERSONA_PREFIX_SECTION} can override it; `{{variable}}` references are strict.
   */
  personaPrefix?: string
  /**
   * Persona suffix template after first-party guidance. A section named
   * {@link PERSONA_SUFFIX_SECTION} can override it; `{{variable}}` references are strict. Defaults to empty.
   */
  personaSuffix?: string
  /**
   * Model-facing tool names in order, with {@link TOOL_ORDER_REST} exactly once.
   * Invalid fields fail at load and unknown names fail at assembly; known names
   * hidden in one scope may be absent there. Omitted means lexicographic order.
   */
  toolOrder?: string[]
}

/**
 * Interpolate strict `{{variable}}` references, trim each section, drop empty
 * text, and join the rest with blank lines. Sections with `interpolate: false` retain literal
 * text except for surrounding whitespace. Malformed, unknown, or undefined
 * references in other sections throw; a lone `{{` without any later `}}` is
 * literal prose, and substituted values are not scanned again.
 * @param assembly - the assembly whose sections and variables to render.
 * @returns the rendered prompt, or `''` when all sections are empty.
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections.filter(section => !section.retire)
    .map(section => section.interpolate === false ? section.text : interpolate(section, assembly.variables, 'section'))
    .map(text => text.trim())
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * Render the complete dynamic context snapshot, preserving literal contributions.
 * @param assembly - the assembly whose contexts and variables to render.
 * @returns the current full snapshot, or `''` when no context is active.
 */
export function renderContextSnapshot(assembly: PromptAssembly): string {
  return joinContextSections(renderContextSections(assembly))
}

/**
 * The model-facing snapshot text for an already-rendered section list.
 *
 * A caller that also needs the sections renders them once and joins here, so a
 * request does not interpolate every context twice.
 * @param sections - sections from {@link renderContextSections}.
 * @returns the current full snapshot, or `''` when no context is active.
 */
export function joinContextSections(sections: readonly ContextSnapshotSection[]): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

/**
 * The same snapshot, kept as the named contributions it was assembled from.
 *
 * {@link renderContextSnapshot} joins these for the model; a consumer that
 * presents the snapshot uses them to attribute each part to the subsystem that
 * contributed it, without re-splitting the joined prose. Contributions with
 * `interpolate: false` preserve literal text instead of resolving prompt variables.
 * @param assembly - the assembly whose contexts and variables to render.
 * @returns one entry per contributing context that rendered to non-empty text.
 */
export function renderContextSections(assembly: PromptAssembly): ContextSnapshotSection[] {
  return assembly.contexts
    .map(context => ({
      name: context.name,
      text: context.interpolate === false ? context.text : interpolate(context, assembly.variables, 'context'),
    }))
    .filter(section => section.text.length > 0)
}

/** Interpolate one section or context and attribute diagnostics to its owning input. */
function interpolate(
  input: AssembledSection | AssembledContext,
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // A later closing brace makes this malformed; otherwise it is literal prose.
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}" (references are complete simple {{name}} groups)`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    // `{{}}` yields an empty name and follows the malformed-reference path.
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    // Do not resolve unregistered names through Object.prototype.
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/** Resolve one registered runtime fact without assembling sections or tools. */
function resolveContext(entry: PromptContext, context: AssembleContext): AssembledContext {
  return {
    name: entry.name,
    text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
    ...entry.interpolate !== undefined ? { interpolate: entry.interpolate } : {},
  }
}

/** One tool-schema provider stored in a prompt layer. */
type ToolProvider = (context: AssembleContext) => ToolProviderResult

/** One prompt-variable provider stored in a prompt layer. */
type VariableProvider = (context: AssembleContext) => string | undefined

/** All prompt registrations owned by one global or scoped layer. */
class PromptLayer implements ScopeLayer {
  /** Same-name registrations in insertion order; disposal removes the exact entry. */
  readonly sections = new Map<string, SectionRegistration[]>()
  readonly contexts: NamedEntries<PromptContext>
  readonly runtimeContextSuppressors = new AnonymousEntries<true>()
  readonly toolProviders = new AnonymousEntries<ToolProvider>()
  readonly variables: NamedEntries<VariableProvider>

  /**
   * Create one prompt layer with diagnostics specific to its ownership scope.
   * @param scope - the scoped owner, or `undefined` for global registrations.
   */
  constructor(scope: ScopeKey | undefined) {
    this.contexts = new NamedEntries(name => new Error(scope === undefined
      ? `prompt context "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt context "${name}" is already registered in this scope`))
    this.variables = new NamedEntries(name => new Error(scope === undefined
      ? `prompt variable "${name}" is already registered (for a per-agent value, register through that agent's \`agent.ctx\` instead)`
      : `prompt variable "${name}" is already registered in this scope`))
  }

  /** @returns whether this layer owns no prompt registrations. */
  isEmpty(): boolean {
    return this.sections.size === 0
      && this.contexts.isEmpty()
      && this.runtimeContextSuppressors.isEmpty()
      && this.toolProviders.isEmpty()
      && this.variables.isEmpty()
  }
}

/** Registry service for the prompt inputs assembled before each model step. */
export class SystemPrompt extends Service {
  static inject = ['sessionProjections']
  static Config: z<Config> = z.object({
    includeHarnessIdentity: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    personaPrefix: z.string().default(''),
    personaSuffix: z.string().default(''),
    // Preserve omission because an explicit empty order lacks the rest marker.
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private readonly layers = new ScopedLayers(
    scope => new PromptLayer(scope),
    () => { this.ctx.emit('system-prompt/change') },
  )
  private readonly toolOrder: string[] | undefined
  /** Orders disposals without retaining dead registrations in the shared registry. */
  private readonly retirementOrder = { next: 0 }
  /** Visible owners captured per Session, including disposed definitions awaiting admission. */
  private readonly sessionSources = new WeakMap<Session, Map<string, SectionRegistration[]>>()
  /** Initialized before dependent plugins activate. */
  private admission!: ProjectionHandle<SectionAdmissions>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'systemPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    // Keep harness-owned openers independent of the selected loop plugin.
    if (config.includeHarnessIdentity ?? true) {
      this.section({
        name: 'harness:identity',
        order: this.getSectionOrder('HARNESS_IDENTITY'),
        text: 'You are an AI agent powered by DeepSeek Harness.',
      })
    }
    this.section({
      name: PERSONA_PREFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      // The fallback narrows the optional input type; the schema already defaults it.
      text: config.personaPrefix ?? '',
    })
    this.section({
      name: PERSONA_SUFFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: config.personaSuffix ?? '',
    })
    if (!(config.includeRuntimeContext ?? true)) this.suppressRuntimeContext()
  }

  protected async [Service.init](): Promise<void> {
    this.admission = await this.ctx.sessionProjections.register(sectionAdmissionsDefinition)
  }

  /**
   * Register a section; the nearest scope wins, then the latest registration
   * within that scope. Disposal reveals the next live definition. Retirement
   * is admitted only after no registration remains in the visible scope chain.
   * @param section - definition, canonical order and optional transition notices.
   * @returns the exact Cordis disposer; retirement is observed at later assembly.
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    if (section.retirement?.trim().length === 0) {
      throw new TypeError(`retirement for prompt section "${section.name}" requires nonempty literal text`)
    }
    const registration: SectionRegistration = { definition: section }
    const retirementOrder = this.retirementOrder
    return this.layers.effect(this.ctx, (layer) => {
      const registrations = layer.sections.get(section.name) ?? []
      layer.sections.set(section.name, registrations)
      registrations.push(registration)
      return () => {
        registration.disposedAt = retirementOrder.next++
        registrations.splice(registrations.indexOf(registration), 1)
        if (registrations.length === 0) layer.sections.delete(section.name)
      }
    }, { label: 'systemPrompt.section()' })
  }

  /**
   * Resolve the centrally owned placement of a repository prompt section.
   * @param name - stable section placement name.
   * @returns the section's numeric sort order.
   */
  getSectionOrder(name: PromptSectionOrderName): number {
    return SECTION_ORDERS[name]
  }

  /**
   * Resolve the centrally owned placement of a repository runtime context.
   * @param name - stable context placement name.
   * @returns the context's numeric sort order.
   */
  getContextOrder(name: PromptContextOrderName): number {
    return CONTEXT_ORDERS[name]
  }

  /**
   * Register ordered dynamic context in the calling context's scope. Scoped
   * entries shadow global entries with the same name.
   * @param context - the context contribution to register.
   * @returns the exact Cordis effect disposer.
   */
  context(context: PromptContext): () => void {
    if (!Number.isFinite(context.order)) {
      throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.contexts.insert(context.name, context),
      { label: 'systemPrompt.context()' },
    )
  }

  /**
   * Suppress optional dynamic runtime-context contributions in the calling
   * context's scope without changing the services that own or enforce those
   * facts. Multiple suppressors remain independently disposable.
   * @returns the exact Cordis effect disposer.
   */
  suppressRuntimeContext(): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.runtimeContextSuppressors.append(true),
      { label: 'systemPrompt.suppressRuntimeContext()' },
    )
  }

  /**
   * Register a tool-schema provider in the calling context's scope. Global and
   * matching scoped providers both contribute; returning the reserved
   * {@link TOOL_ORDER_REST} name makes assembly fail.
   * @param provider - evaluated for each assembly with its context.
   * @returns the exact Cordis effect disposer.
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.toolProviders.append(provider),
      { label: 'systemPrompt.tools()' },
    )
  }

  /**
   * Register a prompt variable in the calling context's scope. Scoped values
   * shadow globals; invalid or duplicate names throw. A provider may return
   * `undefined`, but rendering a section that references that value then fails.
   * @param name - the `[a-z][a-z0-9_]*` reference name.
   * @param provider - evaluated for each assembly.
   * @returns the exact Cordis effect disposer.
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.variables.insert(name, provider),
      { label: 'systemPrompt.variable()' },
    )
  }

  /**
   * Refresh accepted registered runtime facts for request admission. Contexts
   * added only by the assembly waterfall retain their accepted values. Current
   * suppression removes optional contexts, and missing required registrations
   * are restored in registry order. Sections, tools, and interpolation variables
   * retain the accepted assembly; their providers and waterfall do not rerun.
   * @param assembly - accepted assembly for this scope and step.
   * @param context - the same scope and current plugin-defined assembly fields.
   * @returns the accepted assembly with current runtime-context provider text.
   */
  refreshContext(assembly: PromptAssembly, context: AssembleContext = {}): PromptAssembly {
    const providers = this.layers.merge(context.scope, layer => layer.contexts)
    const suppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
      || this.layers.chainLayers(context.scope).some(layer => !layer.runtimeContextSuppressors.isEmpty())
    const required = new Map([...providers].filter(([, entry]) => entry.required === true))
    const contexts: AssembledContext[] = []
    for (const accepted of assembly.contexts) {
      const provider = providers.get(accepted.name)
      required.delete(accepted.name)
      if (suppressed && provider?.required !== true) continue
      contexts.push(provider === undefined ? accepted : resolveContext(provider, context))
    }
    for (const provider of required.values()) {
      const index = contexts.findIndex((entry) => {
        const next = providers.get(entry.name)
        return next !== undefined && next.order > provider.order
      })
      contexts.splice(index < 0 ? contexts.length : index, 0, resolveContext(provider, context))
    }
    return { ...assembly, contexts }
  }

  /**
   * Assemble global and scoped providers, detach tool parameters, apply
   * canonical ordering, then run the presentation waterfall. Scoped variables
   * shadow globals; section IDs have one effective owner. The waterfall's text is authoritative except
   * that an effective complete section is restored afterwards as the sole
   * prompt section; tool declarations stay provider-owned. Section text and
   * lifecycle are fixed here; `systemUpdates()` compares them with committed state later.
   * @param context - the optional scope, step tool set, and plugin-defined assembly fields.
   * @returns the post-waterfall presentation and the system updates for the supplied Session.
   */
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    const scope = context.scope

    // Committed names and provider values are captured before the waterfall can yield.
    const session = context.session
    const committed = session === undefined ? undefined : this.admission.stateOf(session)
    const retained = context.session === undefined
      ? new Map<string, SectionRegistration[]>()
      : this.sessionSources.get(context.session) ?? new Map<string, SectionRegistration[]>()
    if (context.session !== undefined) this.sessionSources.set(context.session, retained)

    // Outer scopes are visited first; later registrations replace the effective definition.
    const scopeLayers = this.layers.chainLayers(scope)
    const visibleLayers = [this.layers.global, ...scopeLayers]
    const sectionByName = new Map<string, PromptSection & { retire?: true }>()
    const visibleRegistrations = new Map<string, SectionRegistration[]>()
    for (const layer of visibleLayers) {
      for (const [name, registrations] of layer.sections) {
        const inherited = visibleRegistrations.get(name) ?? []
        visibleRegistrations.set(name, inherited.concat(registrations))
        for (const registration of registrations) sectionByName.set(name, registration.definition)
      }
    }
    for (const [name, registrations] of visibleRegistrations) {
      retained.set(name, registrations)
    }

    const admittedNames = new Set(committed?.sections.map(section => section.name))
    for (const [name, registrations] of retained) {
      let retiredDefinition: PromptSection | undefined
      let lastDisposal = -1
      for (const registration of registrations) {
        const disposedAt = registration.disposedAt
        if (disposedAt === undefined) {
          // Any live owner keeps the logical source active, regardless of other disposals.
          retiredDefinition = undefined
          break
        }
        if (disposedAt > lastDisposal) {
          retiredDefinition = registration.definition
          lastDisposal = disposedAt
        }
      }
      if (retiredDefinition === undefined) continue
      if (!admittedNames.has(name)) {
        retained.delete(name)
        continue
      }
      sectionByName.set(name, {
        name,
        order: retiredDefinition.order,
        text: retiredDefinition.retirement ?? `The earlier instructions from ${name} no longer apply.`,
        interpolate: false,
        retire: true,
      })
    }

    const runtimeContextSuppressed = visibleLayers.some(layer => !layer.runtimeContextSuppressors.isEmpty())
    const variables: Record<string, string | undefined> = {}
    for (const layer of visibleLayers) {
      for (const [name, provider] of layer.variables.entries()) {
        variables[name] = provider(context)
      }
    }
    const contextByName = this.layers.merge(scope, layer => layer.contexts)

    // Keep all declared names for order validation, including tools restricted from this step.
    const providers = visibleLayers.flatMap(layer => [...layer.toolProviders.values()])
    const collected: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      const result = provider(context)
      const schemas = result.schemas.map(({ name, description, parameters, deferLoading }): ToolSchema => ({
        name,
        description,
        parameters: structuredClone(parameters),
        ...deferLoading === true ? { deferLoading } : {},
      }))
      collected.push(...schemas)
      const acceptedKnownNames = result.knownNames ?? schemas.map(tool => tool.name)
      for (const name of acceptedKnownNames) knownNames.add(name)
    }

    const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections)
    const completeSections = sectionDefinitions.filter(section => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(`multiple complete prompt sections are active: ${completeSections.map(section => JSON.stringify(section.name)).join(', ')}`)
    }
    const sections: AssembledSection[] = []
    let completeSection: AssembledSection | undefined
    for (const section of sectionDefinitions) {
      const text = typeof section.text === 'function' ? section.text(context) : section.text
      const assembled: AssembledSection = { name: section.name, order: section.order, text }
      if (section.interpolate !== undefined) assembled.interpolate = section.interpolate
      if (section.replacement !== undefined) assembled.replacement = section.replacement
      if (section.retire !== undefined) assembled.retire = section.retire
      if (section.complete !== undefined) assembled.complete = section.complete
      if (section.complete === true) completeSection = { ...assembled }
      sections.push(assembled)
    }
    const tools = orderTools(collected, this.toolOrder, knownNames)
    const contexts = [...contextByName.values()]
      .filter(entry => !runtimeContextSuppressed || entry.required === true)
      .sort((a, b) => a.order - b.order)
      .map(entry => resolveContext(entry, context))
    const assembly: PromptPresentation = { sections, contexts, variables }
    const transformed = await this.ctx.waterfall(
      scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
      () => Promise.resolve(assembly),
    )

    const presentation: PromptPresentation = {
      ...transformed,
      sections: [...transformed.sections].sort(comparePromptSections),
    }
    if (completeSection !== undefined) {
      // A registered complete prompt cannot be altered or supplemented by middleware.
      presentation.sections = [completeSection]
    }
    if (runtimeContextSuppressed) {
      const requiredNames = new Set([...contextByName.values()].filter(entry => entry.required === true).map(entry => entry.name))
      presentation.contexts = transformed.contexts.filter(entry => requiredNames.has(entry.name))
    }

    if (session === undefined) {
      return { ...presentation, tools, systemUpdates: () => [] }
    }
    const renderedSections = presentation.sections.map((section): RenderedSection => {
      const text = section.interpolate === false ? section.text : interpolate(section, presentation.variables, 'section')
      if (section.retire) {
        return { kind: 'retired', name: section.name, order: section.order, notice: text.trim(), complete: section.complete === true }
      }
      return {
        kind: 'active', name: section.name, order: section.order, text: text.trim(),
        replacement: section.replacement?.trim(), complete: section.complete === true,
      }
    })
    assertDistinctSections(renderedSections)
    return { ...presentation, tools, systemUpdates: retry => this.systemUpdates(session, renderedSections, retry) }
  }

  /** Writes that bring a Session's committed sections to one assembly's captured sections. */
  private systemUpdates(session: Session, sections: readonly RenderedSection[], retry: boolean): SystemUpdate[] {
    const state = this.admission.stateOf(session)
    // System changes that another writer logs between attempts wait for the next assembly.
    if (retry && !state.needsRebuild) return []
    const admission = assembleSystemAdmission(state, sections)
    if (admission.kind === 'append') {
      // The first commitment reserves a system head even without instructions.
      const messages = admission.messages.length === 0 && session.surface.nodes.length === 0
        ? [createMessage({ role: 'system', content: [], source: { kind: 'system-prompt', sections: [] } })]
        : admission.messages
      return messages.map(message => ({ message, intent: { surfaceOp: 'append' } }))
    }

    const [head, ...additions] = session.surface.systemNodes
    const updates: SystemUpdate[] = []
    for (const { seq, isEmpty } of additions) {
      if (isEmpty) continue
      const message = createMessage({
        role: 'system', content: [], source: { kind: 'system-prompt', sections: [] },
      })
      updates.push({ message, intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] } })
    }
    // A head reset completes recovery; write it last so interrupted cleanup stays pending.
    updates.push({ message: admission.message, intent: head === undefined
      ? { surfaceOp: 'append' }
      : { surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq] } })
    return updates
  }

}

export default SystemPrompt
