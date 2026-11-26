/** Flat registrations and live inclusions shared by registry implementations. @module */
import { AnonymousEntries, NamedEntries } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { assertSupportedJsonSchema } from './json-schema.ts'
import { RUN_CODE_NAME, ToolCompositionError } from './contracts.ts'
import type { ToolDefinition } from './contracts.ts'
import type { ToolRegistry } from './registry.ts'

/** The read methods of a registry that another registry includes. */
export type ToolSource = Pick<ToolRegistry, 'get' | 'getAll'>

/** Several different definitions that one place offers under one name. */
class AmbiguousCandidate {
  /** @param definitions - the conflicting definitions in the order the place offers them. */
  constructor(readonly definitions: readonly ToolDefinition[]) {}
}

/** One place's resolution of a name: a definition, or several conflicting ones. */
export type ToolCandidate = ToolDefinition | AmbiguousCandidate

/**
 * Add one definition to a place's candidate for its name; the same definition
 * reached twice stays one candidate, and different definitions conflict.
 * @param existing - the candidate collected so far, if any.
 * @param definition - a definition the place offers under the same name.
 * @returns the merged candidate.
 */
export function mergeToolCandidate(existing: ToolCandidate | undefined, definition: ToolDefinition): ToolCandidate {
  if (existing === undefined || existing === definition) return definition
  const definitions = existing instanceof AmbiguousCandidate ? existing.definitions : [existing]
  return definitions.includes(definition) ? existing : new AmbiguousCandidate([...definitions, definition])
}

/**
 * Validate one definition before a registry retains it.
 * @param definition - definition supplied to `register()`.
 * @throws TypeError when the output declaration or timeout is invalid.
 * @throws Error when the definition uses the reserved `run_code` name.
 */
export function assertToolDefinition(definition: ToolDefinition): void {
  const name = definition.name
  const output = (definition as Partial<ToolDefinition>).output
  if (output === undefined || typeof output !== 'object'
    || typeof output.render !== 'function'
    || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
  }
  assertSupportedJsonSchema(output.schema)
  const timeoutMs = definition.timeoutMs
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
  }
  // Reserved unconditionally: any Agent may select a PTC root for itself, so a
  // name free under the deployment default would collide once a preset mounted one.
  if (name === RUN_CODE_NAME) {
    throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC program entry and cannot be registered or shadowed`)
  }
}

/**
 * Collect one place's candidates: its own registrations, then the entries of
 * each included registry for the viewing scope. The same definition reached
 * twice stays one candidate; different definitions under one name conflict.
 * @param own - definitions this place offers itself; a repeated name merges like an included one.
 * @param sources - registries included in this place.
 * @param scope - viewing scope passed to every included registry.
 * @returns candidates by name in first-seen order.
 */
export function collectToolCandidates(
  own: Iterable<ToolDefinition>,
  sources: Iterable<ToolSource>,
  scope: ScopeKey | undefined,
): Map<string, ToolCandidate> {
  const candidates = new Map<string, ToolCandidate>()
  const add = (definition: ToolDefinition): void => {
    candidates.set(definition.name, mergeToolCandidate(candidates.get(definition.name), definition))
  }
  for (const definition of own) add(definition)
  for (const source of sources) {
    for (const definition of source.getAll(scope)) add(definition)
  }
  return candidates
}

/**
 * Find one name among a place's registration and its included registries.
 * @param own - the place's own registration with the name, if any.
 * @param sources - registries included in the place.
 * @param name - tool name to find.
 * @param scope - viewing scope passed to every included registry.
 * @returns the definition, the conflicting definitions when several differ, or undefined.
 */
export function findToolCandidate(
  own: ToolDefinition | undefined,
  sources: Iterable<ToolSource>,
  name: string,
  scope: ScopeKey | undefined,
): ToolCandidate | undefined {
  let found: ToolCandidate | undefined = own
  for (const source of sources) {
    const definition = source.get(name, scope)
    if (definition !== undefined) found = mergeToolCandidate(found, definition)
  }
  return found
}

/**
 * Resolve one deciding candidate.
 * @param name - tool name being resolved.
 * @param candidate - the deciding place's candidate, if any.
 * @returns the definition, or undefined when no place offers the name.
 * @throws ToolCompositionError when the deciding place offers several definitions.
 */
export function resolveToolCandidate(name: string, candidate: ToolCandidate | undefined): ToolDefinition | undefined {
  if (candidate instanceof AmbiguousCandidate) throw ambiguousTool(name, candidate)
  return candidate
}

/**
 * Resolve every visible candidate.
 * @param candidates - deciding candidates by name.
 * @returns definitions in candidate order.
 * @throws ToolCompositionError when any visible name is ambiguous.
 */
export function resolveToolCandidates(candidates: ReadonlyMap<string, ToolCandidate>): ToolDefinition[] {
  const definitions: ToolDefinition[] = []
  for (const [name, candidate] of candidates) {
    if (candidate instanceof AmbiguousCandidate) throw ambiguousTool(name, candidate)
    definitions.push(candidate)
  }
  return definitions
}

/**
 * List every definition of the candidates, keeping each conflict's definitions
 * so a registry that includes this list decides the name in its own place.
 * @param candidates - candidates by name.
 * @returns definitions in candidate order.
 */
export function listToolCandidates(candidates: ReadonlyMap<string, ToolCandidate>): ToolDefinition[] {
  return [...candidates.values()].flatMap(candidate => candidate instanceof AmbiguousCandidate ? candidate.definitions : [candidate])
}

/**
 * Resolve a registry listing to one definition per name.
 * @param definitions - a registry's `getAll()` result.
 * @returns definitions in first-seen order.
 * @throws ToolCompositionError when the listing offers several definitions under one name.
 */
export function resolveToolList(definitions: readonly ToolDefinition[]): ToolDefinition[] {
  return resolveToolCandidates(collectToolCandidates(definitions, [], undefined))
}

/**
 * Build the failure for a name with several definitions in the place that
 * decides it. The message quotes the first line of each definition's
 * description so a developer can find the plugins that register them.
 */
function ambiguousTool(name: string, candidate: AmbiguousCandidate): ToolCompositionError {
  const described = candidate.definitions.map(definition => JSON.stringify(summaryLine(definition.description))).join(', ')
  return new ToolCompositionError(`tool "${name}" has several definitions in the scope that decides it (described as ${described}); register or include one definition per name`)
}

/** The first line of a description, shortened for a diagnostic. */
function summaryLine(description: string): string {
  const line = description.split('\n', 1).join('')
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/**
 * Registrations and inclusions of a registry that has no scopes. Queries pass
 * the viewing scope to included registries, so a scoped source such as
 * `ctx.tools` still resolves per Agent.
 */
export class ToolEntries {
  private readonly own = new NamedEntries<ToolDefinition>(name => new Error(`tool "${name}" is already registered in ${this.owner}`))
  private readonly sources = new AnonymousEntries<ToolSource>()
  private resolving = false

  /** @param owner - registry label used in duplicate and cycle diagnostics. */
  constructor(private readonly owner: string) {}

  /**
   * Add one definition.
   * @param tool - validated definition with a name unique among this registry's registrations.
   * @returns the idempotent disposer for this registration.
   * @throws Error when the name is already registered here or reserved.
   * @throws ToolCompositionError when an inclusion already offers another definition with the name.
   */
  register(tool: ToolDefinition): () => void {
    assertToolDefinition(tool)
    return this.composed(this.own.insert(tool.name, tool), () => [tool.name])
  }

  /**
   * Include another registry's entries.
   * @param registry - live source.
   * @returns the idempotent disposer for this inclusion.
   * @throws ToolCompositionError when this registry then offers two definitions under one of the source's names or
   * the source cycles.
   */
  include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void {
    return this.composed(this.sources.append(registry), () => registry.getAll().map(definition => definition.name))
  }

  /** Resolve the names one contribution offers in the unscoped view, undoing it before rethrowing. */
  private composed(undo: () => void, names: () => readonly string[]): () => void {
    try {
      this.resolve(() => {
        for (const name of new Set(names())) {
          resolveToolCandidate(name, findToolCandidate(this.own.get(name), this.sources.values(), name, undefined))
        }
      })
    } catch (error: unknown) {
      undo()
      throw error
    }
    return undo
  }

  /**
   * Resolve one name.
   * @param name - tool name.
   * @param scope - viewing scope passed to included registries.
   * @returns the definition, or undefined.
   * @throws ToolCompositionError on conflicting candidates or an inclusion cycle.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return resolveToolCandidate(name, this.resolve(() => findToolCandidate(this.own.get(name), this.sources.values(), name, scope)))
  }

  /**
   * List every definition. A name with several definitions lists each of them;
   * `get()` and {@link resolveAll} report the conflict.
   * @param scope - viewing scope passed to included registries.
   * @returns definitions in registration order, then inclusion order.
   * @throws ToolCompositionError on an inclusion cycle.
   */
  getAll(scope?: ScopeKey): readonly ToolDefinition[] {
    return listToolCandidates(this.candidates(scope))
  }

  /**
   * List one definition per name.
   * @param scope - viewing scope passed to included registries.
   * @returns definitions in registration order, then inclusion order.
   * @throws ToolCompositionError on conflicting candidates or an inclusion cycle.
   */
  resolveAll(scope?: ScopeKey): readonly ToolDefinition[] {
    return resolveToolCandidates(this.candidates(scope))
  }

  private candidates(scope: ScopeKey | undefined): Map<string, ToolCandidate> {
    return this.resolve(() => collectToolCandidates([...this.own.values()], this.sources.values(), scope))
  }

  private resolve<T>(read: () => T): T {
    if (this.resolving) throw new ToolCompositionError(`tool registry inclusion cycle reaches ${this.owner}`)
    this.resolving = true
    try {
      return read()
    } finally {
      this.resolving = false
    }
  }
}
