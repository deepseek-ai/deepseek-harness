// @vitest-environment jsdom
import { memo, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ActionCardDecision, ActionCardResult, ActionCardView } from '@deepseek-ai/dsh-action-cards/types'
import { ActionCard, ActionCardTail, FoldedText } from '../src/client/Card.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en, zh } from '../src/client/locales.ts'
import type { ActionCardBodyProps, RegisteredBody } from '../src/client/registry.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

type CardProps = ComponentProps<typeof ActionCard>
const callId = ToolCallId('card-1')
const proposal = { callId, turn: 3, action: 'test_action', title: 'Counter', brief: 'Keep my task count visible.', details: { value: 'a' } }

function props(bodies: ReadonlyMap<string, RegisteredBody> = new Map(), decision?: ActionCardDecision, chinese = false): CardProps {
  return { proposal, decision, sessionId: SessionId('session-1'),
    act: vi.fn(async (): Promise<ActionCardResult | undefined> => ({ status: 'settled', decision: { callId, action: 'test_action', phase: 'dismissed' } })),
    bind: vi.fn(() => (key: string) => `body:${key}`),
    useBodies: selector => selector(bodies),
    t: makeTranslate(chinese ? zh : en) }
}

it('places the card admitted in its turn once the turn has ended with an answer, and leaves other turns empty', () => {
  type Tail = ComponentProps<typeof ActionCardTail>
  const value = props()
  let view: ActionCardView | undefined
  const turnData = vi.fn().mockReturnValue({ closing: {} })
  const ended = { type: 'turn/end', seq: SessionSeq(1), time: 0, data: { turn: 3, reason: { kind: 'max-tokens' } } } as const
  const tail = (end: typeof ended | undefined): Tail => ({ ...value, useProjection: () => view,
    turn: { turn: 3, start: undefined, end, status: end === undefined ? 'open' : 'closed', steps: [],
      data: { get: turnData, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) } } })
  const card = (id: string, turn: number) => ({ ...proposal, callId: ToolCallId(id), turn })
  const { rerender } = render(<ActionCardTail {...tail(ended)} />)
  expect(screen.queryByRole('region')).toBeNull()
  view = { decisions: {}, proposals: { earlier: card('earlier', 2) } }
  rerender(<ActionCardTail {...tail(ended)} />)
  expect(screen.queryByRole('region')).toBeNull()
  view = { decisions: {}, proposals: { ...view.proposals, b: card('b', 3), a: card('a', 3), c: card('c', 3) } }
  rerender(<ActionCardTail {...tail(ended)} />)
  expect(screen.getAllByRole('region').map(region => region.getAttribute('data-action-card'))).toEqual(['a'])
  expect(screen.getByRole('region', { name: 'Counter' }).getAttribute('data-action')).toBe('test_action')
  expect(turnData).toHaveBeenCalledWith('turn-tail')
  rerender(<ActionCardTail {...tail(undefined)} />)
  expect(screen.queryByRole('region')).toBeNull()
  turnData.mockReturnValueOnce({ closing: null })
  rerender(<ActionCardTail {...tail(ended)} />)
  expect(screen.queryByRole('region')).toBeNull()
  view = { ...view, decisions: { a: { callId: ToolCallId('a'), action: 'test_action', phase: 'dismissed' } } }
  rerender(<ActionCardTail {...tail(ended)} />)
  expect(screen.getByRole('status').textContent).toBe(en.dismissed)
  // A call id naming an inherited object member reads no decision.
  view = { decisions: {}, proposals: { toString: card('toString', 3) } }
  rerender(<ActionCardTail {...tail(ended)} />)
  expect(screen.getByRole('region').getAttribute('data-action-card')).toBe('toString')
  expect(screen.getByRole('button', { name: en.dismiss })).toBeTruthy()
})

it('renders a registered body with the frame summary, the fold, its own translator and an action bound to the card', async () => {
  const seen: ActionCardBodyProps<never>[] = []
  const Body = memo((body: ActionCardBodyProps<never>) => {
    seen.push(body)
    return <div>{body.summary}<button type="button" onClick={() => { void body.act('start', { value: 'x' }) }}>{body.t('start' as never)}</button>
      <body.Folded text="Long details" expandLabel="more" collapseLabel="less" /></div>
  })
  const bodies = new Map<string, RegisteredBody>([['test_action', { locale: 'testCard', render: (frame, t) => <Body {...frame} t={t} /> }]])
  const value = props(bodies, { callId, action: 'test_action', phase: 'running' })
  render(<ActionCard {...value} />)
  expect(value.bind).toHaveBeenCalledWith('testCard')
  expect(screen.getByRole('region', { name: 'Counter' }).textContent).toContain('Keep my task count visible.')
  expect(screen.getByText('Long details')).toBeTruthy()
  expect(seen.at(-1)).toMatchObject({ proposal, decision: { phase: 'running' }, sessionId: 'session-1', Folded: FoldedText })
  fireEvent.click(screen.getByRole('button', { name: 'body:start' }))
  expect(value.act).toHaveBeenCalledWith(callId, 'start', { value: 'x' })
})

it('offers only Not now for a card whose kind registered no body, and reports refusals and lost replies', async () => {
  const value = props(new Map(), undefined, true)
  const pending = Promise.withResolvers<ActionCardResult | undefined>()
  value.act = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce({ status: 'unconfirmed', reason: 'closing' })
    .mockResolvedValueOnce({ status: 'accepted' })
  render(<ActionCard {...value} />)
  expect(screen.getByRole('region', { name: 'Counter' }).textContent).toContain('Keep my task count visible.')
  const dismiss = screen.getByRole('button', { name: zh.dismiss })
  fireEvent.click(dismiss)
  expect(dismiss.hasAttribute('disabled')).toBe(true)
  expect(value.act).toHaveBeenCalledWith(callId, 'dismiss', undefined)
  await act(async () => { pending.resolve({ status: 'refused', reason: 'unknown' }) })
  expect(screen.getByRole('alert').textContent).toBe(zh.unavailable)
  for (const text of [zh.transport, zh.transport, zh.unavailable]) {
    fireEvent.click(screen.getByRole('button', { name: zh.dismiss }))
    await vi.waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(text) })
  }
  fireEvent.click(screen.getByRole('button', { name: zh.dismiss }))
  await vi.waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
})

it('dismisses a card through the fallback Not now when the Host records the dismissal without the card kind', async () => {
  const value = props()
  render(<ActionCard {...value} />)
  const dismiss = screen.getByRole('button', { name: en.dismiss })
  fireEvent.click(dismiss)
  expect(value.act).toHaveBeenCalledWith(callId, 'dismiss', undefined)
  await vi.waitFor(() => { expect(dismiss.hasAttribute('disabled')).toBe(false) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([['dismissed', en.dismissed], ['replaced', en.replaced], ['finished', undefined], ['toString', undefined]] as const)(
  'shows the fallback status of a %s card without actions', (phase, text) => {
    render(<ActionCard {...props(new Map(), { callId, action: 'test_action', phase })} />)
    expect(screen.queryByRole('status')?.textContent).toBe(text)
    expect(screen.queryByRole('button', { name: en.dismiss })).toBeNull()
  })

it('only offers expansion for omitted text and preserves the full brief without layout measurement', () => {
  vi.stubGlobal('ResizeObserver', undefined)
  const short = 'Keep my task count visible.\n\nPersist across conversations.\nVerify removal.'
  const view = render(<FoldedText text={short} expandLabel={zh.expandBrief} collapseLabel={zh.collapseBrief} />)
  expect(screen.queryByRole('button', { name: zh.expandBrief })).toBeNull()
  expect(screen.getByText(/Keep my task count visible/).textContent).toBe(short)
  // 129 wide graphemes (258 units) plus one narrow emoji fill the 260-unit budget; the next grapheme folds.
  const prefix = '计'.repeat(129) + '👩🏽‍💻'
  const long = prefix + '\n\n保留完整方案，点击创建后交给 Creator。'
  view.rerender(<FoldedText text={long} expandLabel={zh.expandBrief} collapseLabel={zh.collapseBrief} />)
  const expand = screen.getByRole('button', { name: zh.expandBrief })
  const paragraph = document.getElementById(expand.getAttribute('aria-controls')!)!
  expect(paragraph.textContent).toBe(prefix + '…')
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(expand)
  expect(screen.getByRole('button', { name: zh.collapseBrief }).getAttribute('aria-expanded')).toBe('true')
  expect(paragraph.textContent).toBe(long)
  fireEvent.click(screen.getByRole('button', { name: zh.collapseBrief }))
  expect(paragraph.textContent).toBe(prefix + '…')
  view.rerender(<FoldedText text={prefix} expandLabel={zh.expandBrief} collapseLabel={zh.collapseBrief} />)
  expect(screen.queryByRole('button', { name: zh.expandBrief })).toBeNull()
  expect(paragraph.textContent).toBe(prefix)
})
