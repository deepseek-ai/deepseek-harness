import type {
  ConversationMatchHandler, ConversationNodeDefinition, ConversationNodeDefinitionInput,
} from '../contract/conversation.ts'
import { ConversationDefinitionRegistry } from './definition-registry.ts'

/** A registered Definition and its event-type-selected handler. */
export interface ConversationEventRoute {
  readonly definition: ConversationNodeDefinition
  readonly match: ConversationMatchHandler
}

/** Runtime registry of independently owned Conversation business Definitions. */
export class ConversationEventRegistry extends ConversationDefinitionRegistry<ConversationNodeDefinition> {
  private fallback: ConversationNodeDefinition | undefined
  private routes = new Map<string, ReadonlySet<ConversationEventRoute>>()
  private unrestricted: ReadonlySet<ConversationEventRoute> = new Set()
  private readonly tables = new WeakMap<ConversationNodeDefinition, ReadonlyMap<string, ConversationMatchHandler>>()

  /**
   * Register a uniquely named business Definition for the caller's lifetime.
   * @param definition - Definition contribution.
   * @returns idempotent disposer.
   */
  register(definition: ConversationNodeDefinitionInput): () => void {
    assertDefinitionTarget(definition)
    return this.registerDefinition(
      definition.kind,
      this.resolve(definition),
      `conversation Definition "${definition.kind}" is already registered`,
      `uiConversation.events.register(${JSON.stringify(definition.kind)})`,
    )
  }

  /**
   * Register the sole fallback used only when no ordinary Definition matches.
   * @param input - fallback Definition.
   * @returns idempotent disposer.
   */
  registerFallback(input: ConversationNodeDefinitionInput): () => void {
    assertDefinitionTarget(input)
    const target = input.target
    if (target === undefined) throw new Error('conversation fallback Definition must declare a target')
    if (this.fallback !== undefined) throw new Error('conversation fallback Definition is already registered')
    const definition = this.resolve(input)
    const dispose = this.ctx.effect(() => {
      this.fallback = definition
      this.refresh()
      return () => {
        if (this.fallback !== definition) return
        this.fallback = undefined
        this.refresh()
      }
    }, `uiConversation.events.registerFallback(${JSON.stringify(definition.kind)})`)
    return () => { void dispose() }
  }

  /**
   * Return the current unmatched-event fallback.
   * @returns installed fallback, when present.
   */
  fallbackEntry(): ConversationNodeDefinition | undefined {
    return this.fallback
  }

  /**
   * Read precomputed candidates in registration order; the returned Set is borrowed read-only.
   * @param type - current event type.
   * @returns table handlers for this type together with all function-form handlers.
   */
  forEvent(type: string): ReadonlySet<ConversationEventRoute> {
    return this.routes.get(type) ?? this.unrestricted
  }

  private resolve(input: ConversationNodeDefinitionInput): ConversationNodeDefinition {
    if (typeof input.match === 'function') return input as ConversationNodeDefinition
    const table = new Map(Object.entries(input.match))
    const definition: ConversationNodeDefinition = {
      ...input,
      match: event => table.get(event.type)?.call(definition, event) ?? null,
    }
    this.tables.set(definition, table)
    return definition
  }

  protected override refresh(): void {
    const routes = new Map<string, Set<ConversationEventRoute>>()
    const unrestricted = new Set<ConversationEventRoute>()
    for (const definition of this.definitions.values()) {
      const table = this.tables.get(definition)
      if (table === undefined) {
        const route = { definition, match: definition.match.bind(definition) }
        unrestricted.add(route)
        for (const candidates of routes.values()) candidates.add(route)
      } else {
        for (const [type, match] of table) {
          let candidates = routes.get(type)
          if (candidates === undefined) {
            candidates = new Set(unrestricted)
            routes.set(type, candidates)
          }
          candidates.add({ definition, match: match.bind(definition) })
        }
      }
    }
    this.routes = routes
    this.unrestricted = unrestricted
    super.refresh()
  }
}

function assertDefinitionTarget(definition: ConversationNodeDefinitionInput): void {
  if ((definition.target === undefined) !== (definition.buildViewNode === undefined)) {
    throw new Error(
      `conversation Definition "${definition.kind}" must declare target and buildViewNode together`,
    )
  }
}
