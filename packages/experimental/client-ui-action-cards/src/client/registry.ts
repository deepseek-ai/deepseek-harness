/** Card bodies registered by action kind for the shared card frame. */
import { createElement, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, LocaleNamespaceMap, Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ActionCardDecision, ActionCardFields, ActionCardProposal, ActionCardResult,
} from '@deepseek-ai/dsh-action-cards/types'

/** Props of the frame's folded text, which bodies reuse for their own long fields. */
export interface FoldedTextProps {
  readonly text: string
  readonly expandLabel: string
  readonly collapseLabel: string
}

/** Everything a kind's body receives from the shared frame. */
export interface ActionCardBodyProps<N extends Extract<keyof LocaleNamespaceMap, string>> {
  /** The card as admitted; the body validates `details` with its own schema. */
  readonly proposal: ActionCardProposal
  /** Recorded or derived card state; undefined while the card is unstarted. */
  readonly decision: ActionCardDecision | undefined
  readonly sessionId: SessionId
  /** Title and folded brief rendered by the frame; the body places them in its layout. */
  readonly summary: ReactNode
  /** The frame's width-weighted text fold. */
  readonly Folded: ComponentType<FoldedTextProps>
  /**
   * Send one user action for this card.
   * @param verb - `dismiss` or one of the kind's Host verbs.
   * @param payload - fields the kind's Host handler validates.
   * @returns the Host result, or undefined when the reply was lost.
   */
  readonly act: (verb: string, payload?: ActionCardFields) => Promise<ActionCardResult | undefined>
  /** Translate the body's own locale namespace. */
  readonly t: TranslateNS<N>
}

/** Browser half of one action kind. */
export interface ActionCardDescriptor<N extends Extract<keyof LocaleNamespaceMap, string>> {
  /** Value of the card's `action`. */
  readonly action: string
  /** Locale namespace the body's copy belongs to. */
  readonly locale: N
  /** Kind-owned header, controls, status and footer. */
  readonly Body: ComponentType<ActionCardBodyProps<N>>
}

/** Frame-supplied body props before the kind's translator is bound. */
export type ActionCardFrameProps = Omit<ActionCardBodyProps<never>, 't'>

/** A registered body with its namespace type erased. */
export interface RegisteredBody {
  readonly locale: string
  /**
   * Render the body.
   * @param props - frame-supplied props.
   * @param t - translator bound to {@link locale}.
   * @returns the body element.
   */
  readonly render: (props: ActionCardFrameProps, t: Translate) => ReactNode
}

/** Card bodies by action; the frame renders a dismiss-only fallback for an action without one. */
export class ActionCardRegistry {
  private bodies: ReadonlyMap<string, RegisteredBody> = new Map()
  private readonly listeners = new Set<() => void>()
  /** Current bodies by action; the snapshot changes on every registration change. */
  readonly source: HostObservable<ReadonlyMap<string, RegisteredBody>> = {
    getSnapshot: () => this.bodies,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /** @param ctx - Context whose effects own registered bodies. */
  constructor(private readonly ctx: Context) {}

  /**
   * Register one kind's body. The caller holds the returned disposer inside its own `ctx.effect`, so the body
   * lives exactly as long as the plugin that contributed it.
   * @param descriptor - the kind's action, locale namespace and body.
   * @returns idempotent disposer.
   * @throws when another body already serves the action.
   */
  register<N extends Extract<keyof LocaleNamespaceMap, string>>(descriptor: ActionCardDescriptor<N>): () => void {
    const { action, locale, Body } = descriptor
    const body: RegisteredBody = { locale, render: (props, t) => createElement(Body, { ...props, t }) }
    const dispose = this.ctx.effect(() => {
      if (this.bodies.has(action)) throw new Error(`action-cards: a body for "${action}" is already registered`)
      this.publish(new Map([...this.bodies, [action, body]]))
      return () => {
        const next = new Map(this.bodies)
        next.delete(action)
        this.publish(next)
      }
    }, `action-cards: body ${action}`)
    return () => { void dispose() }
  }

  private publish(bodies: ReadonlyMap<string, RegisteredBody>): void {
    this.bodies = bodies
    for (const listener of [...this.listeners]) listener()
  }
}
