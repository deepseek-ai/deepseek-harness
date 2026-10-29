/** The shared card frame below a completed answer: title, folded brief, and the kind's body or a dismiss-only fallback. */
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {
  ActionCardDecision, ActionCardFields, ActionCardProposal, ActionCardResult, ActionCardView,
} from '@deepseek-ai/dsh-action-cards/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ActionCardKey } from './locales.ts'
import type { FoldedTextProps, RegisteredBody } from './registry.ts'
import css from './Card.module.css'

/** Session-bound actions and registered bodies, without a service in the component. */
export interface TailInjected {
  /**
   * Send one user action for a card of the displayed Session.
   * @param callId - the card's call id.
   * @param verb - `dismiss` or one of the kind's verbs.
   * @param payload - kind-defined fields.
   * @returns the Host result, or undefined when the reply was lost.
   */
  act: (callId: ToolCallId, verb: string, payload?: ActionCardFields) => Promise<ActionCardResult | undefined>
  /**
   * Bind a body's own locale namespace.
   * @param locale - namespace the body declared.
   * @returns its translator.
   */
  bind: (locale: string) => Translate
  hooks: { bodies: HostObservable<ReadonlyMap<string, RegisteredBody>> }
  sessionId: SessionId
}

type TailProps = Pick<PropsRuntime<'conversation.chat.turnTail'>, 'turn' | 'useProjection'>
  & PropsLocale<'actionCards'> & InjectFace<TailInjected>

/** Graphemes drawn about twice as wide as a Latin letter: CJK scripts, CJK punctuation and fullwidth forms. */
const WIDE_GRAPHEME = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-｠￠-￦]/u
/** Preview budget in Latin-letter widths, about two card lines at desktop width. */
const FOLD_WIDTH = 260

/**
 * Fold omitted text without measuring layout; a wide grapheme counts twice so Chinese and English fold near the
 * same line. The full text is never altered.
 * @param props - text and its localized toggle labels.
 * @returns the paragraph and, when text was omitted, its toggle.
 */
export function FoldedText({ text, expandLabel, collapseLabel }: FoldedTextProps) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const preview = useMemo(() => {
    const compact = text.replace(/\s+/g, ' ').trim()
    const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(compact), part => part.segment)
    let width = 0
    for (const [index, character] of characters.entries()) {
      width += WIDE_GRAPHEME.test(character) ? 2 : 1
      if (width > FOLD_WIDTH) return characters.slice(0, index).join('').trimEnd() + '…'
    }
    return undefined
  }, [text])
  return <>
    <p id={id} className={css.text}>{expanded || preview === undefined ? text : preview}</p>
    {preview !== undefined && <Button variant="ghost" size="sm" className={css.toggle} aria-expanded={expanded} aria-controls={id}
      onClick={() => { setExpanded(value => !value) }}>{expanded ? collapseLabel : expandLabel}</Button>}
  </>
}

/** The projection admits at most one card per turn; should several exist, the lowest call id is shown. */
function proposalOf(view: ActionCardView | undefined, turn: number): ActionCardProposal | undefined {
  let found: ActionCardProposal | undefined
  for (const proposal of Object.values(view?.proposals ?? {})) {
    if (proposal.turn === turn && (found === undefined || proposal.callId < found.callId)) found = proposal
  }
  return found
}

function decisionOf(view: ActionCardView | undefined, callId: string): ActionCardDecision | undefined {
  return view !== undefined && Object.hasOwn(view.decisions, callId) ? view.decisions[callId] : undefined
}

/**
 * Place the card admitted in a turn after that turn's final answer, once the turn has ended with one.
 * @param props - Turn location, projection reader, registered bodies and Session-bound actions.
 * @returns the card, or null while the turn is open or when it ended without answer text.
 */
export function ActionCardTail({ turn, useProjection, ...props }: TailProps) {
  const view = useProjection('actionCards')
  const proposal = proposalOf(view, turn.turn)
  return proposal === undefined || turn.end === undefined || turn.data.get('turn-tail')?.closing == null
    ? null : <ActionCard {...props} proposal={proposal} decision={decisionOf(view, proposal.callId)} />
}

/**
 * Render the frame around one card.
 * @param props - the card, its state, registered bodies and actions.
 * @returns the card section.
 */
export function ActionCard({ proposal, decision, sessionId, act, bind, useBodies, t }: {
  proposal: ActionCardProposal
  decision: ActionCardDecision | undefined
} & InjectFace<TailInjected> & PropsLocale<'actionCards'>) {
  const body = useBodies(bodies => bodies.get(proposal.action))
  const send = useCallback((verb: string, payload?: ActionCardFields) => act(proposal.callId, verb, payload), [act, proposal.callId])
  const summary = <>
    <strong className={css.title}>{proposal.title}</strong>
    <FoldedText text={proposal.brief} expandLabel={t('expandBrief')} collapseLabel={t('collapseBrief')} />
  </>
  // The frame re-renders on a locale change and hands the body a new summary, so the body re-renders with it.
  const content = body === undefined
    ? <FallbackBody summary={summary} decision={decision} act={send} t={t} />
    : body.render({ proposal, decision, sessionId, summary, Folded: FoldedText, act: send }, bind(body.locale))
  return <section className={css.card} aria-label={proposal.title} data-action-card={proposal.callId} data-action={proposal.action}>
    {content}
  </section>
}

/** Phases the fallback can name; other kind phases leave only the summary. */
const NAMED_PHASES: Readonly<Record<string, ActionCardKey>> = { dismissed: 'dismissed', replaced: 'replaced' }

/** Title, brief and Not now for a card whose kind registered no body in this browser. */
function FallbackBody({ summary, decision, act, t }: {
  summary: ReactNode
  decision: ActionCardDecision | undefined
  act: (verb: string) => Promise<ActionCardResult | undefined>
} & PropsLocale<'actionCards'>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ActionCardKey>()
  const phase = decision === undefined || !Object.hasOwn(NAMED_PHASES, decision.phase) ? undefined : NAMED_PHASES[decision.phase]
  const dismiss = async () => {
    setPending(true)
    setError(undefined)
    try {
      const result = await act('dismiss')
      if (result === undefined) setError('transport')
      else if (result.status === 'refused' || result.status === 'unconfirmed') setError('unavailable')
    } catch {
      // A lost reply does not prove failure; replay supplies the durable decision.
      setError('transport')
    } finally { setPending(false) }
  }
  return <div className={css.body}>
    {summary}
    {phase !== undefined && <p role="status" className={css.status}>{t(phase)}</p>}
    {error !== undefined && <p role="alert" className={css.status}>{t(error)}</p>}
    {decision === undefined && <footer className={css.footer}>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => { void dismiss() }}>{t('dismiss')}</Button>
    </footer>}
  </div>
}
