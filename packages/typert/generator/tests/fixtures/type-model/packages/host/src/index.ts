import { Service } from '@deepseek-ai/cordis'
import type { ZodType } from 'zod'
import type { AgentPhase, Box, Entity, Flags, Payload, Present, SyntaxZoo } from './models.ts'

export { AgentPhase } from './models.ts'
export type { Box, Entity, Flags, Payload, Present } from './models.ts'

/**
 * Reference-passed capability object.
 * @typert object
 */
export class Agent<State extends object = { ready: boolean }> implements Entity {
  static {}
  static readonly kind: string = 'agent'
  readonly id: string
  state: State
  protected readonly generation: number = 1
  private readonly secret: string = 'fixture'

  constructor(id: string, state: State) {
    this.id = id
    this.state = state
  }

  /** Read the public display label. */
  get label(): string {
    return this.id
  }

  /** Accept a public display label. */
  set label(value: string) {
    void value
  }

  /** Run one typed input. */
  run<Value>(input: Box<Value>): Promise<Present<Value>> {
    return Promise.resolve(input.value as Present<Value>)
  }

  #hiddenStep(): string {
    return this.secret
  }
}

export { Agent as HostAgent }

/** Service exported only through a non-default alias. */
class AliasedService extends Service {
  /** Report readiness. */
  ready(): boolean {
    return true
  }
}

export { AliasedService as PublicAliasedService }

/** Service exported only through the package default. */
class DefaultOnlyService extends Service {
  /** Report readiness. */
  ready(): boolean {
    return true
  }
}

/** Fixture service with generic, mapped, and truly external boundary types. */
export class DemoService extends Service {
  static readonly kind: string = 'demo'
  protected readonly generation: number = 1
  private readonly secret: string = 'fixture'

  /** Inspect one agent without flattening its generic state. */
  inspect(agent: Agent<{ ready: true }>, flags: Flags<Payload>): Present<Payload> {
    return { name: agent.id, count: Object.keys(flags).length }
  }

  /** Keep an npm-owned type as External. */
  acceptsExternal(schema: ZodType<string>): void {
    void schema
  }

  /** Accept a developer-authored enum without flattening it. */
  setPhase(phase: AgentPhase): void {
    void phase
  }

  /** Exercise every retained type-graph shape from a public boundary. */
  inspectSyntax(zoo: SyntaxZoo): void {
    void zoo
  }

  /** Preserve async source metadata without changing its type signature. */
  async inspectAsync(zoo: SyntaxZoo): Promise<void> {
    void zoo
  }

  /** Retain an authored binding-pattern parameter. */
  destructure({ name }: Payload, [suffix]: [string]): string {
    return name + suffix
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    demo: DemoService
    aliased: AliasedService
    defaultOnly: DefaultOnlyService
    ignoredInline: {}
    ignoredPrimitive: string
    ignoredExternal: ZodType<string>
    ignoredMethod(): void
  }

  interface Events {
    /**
     * A generic fixture event.
     * @param agent - emitting agent.
     * @param payload - event payload.
     * @mode emit
     */
    'demo/ready'(agent: Agent<{ ready: true }>, payload: Box<Payload>): void

    'demo/unmodeled'(): void

    'demo/property': (payload: Payload) => void

    /** @mode serial */
    'demo/serial-property': (payload: Payload) => void

    (payload: Payload): void
  }

  interface IgnoredInterface {}

  type IgnoredDeclaration = string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    demo: DemoService
  }

  interface Events {
    'demo/ready'(agent: Agent<{ ready: true }>, payload: Box<Payload>): void
  }
}

export default DefaultOnlyService
