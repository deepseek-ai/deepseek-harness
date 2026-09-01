// Synthetic long-chat history for browser behavior contracts. The fixture is
// generated through Session so pagination exercises the same event shapes as
// persisted conversations, while unique markers identify semantic rows
// without depending on CSS-module names or virtualizer DOM positions.
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
// Carries the session/title event declaration into this fixture builder.
import type {} from '@deepseek-ai/dsh-session-title'

/** Options for one deterministic long-chat fixture. */
export interface ChatScrollFixtureOptions {
  /** Marker namespace, used when two sessions share one browser world. */
  readonly markerPrefix: string
  /** Searchable title projected into the sidebar. */
  readonly title: string
  /** Number of closed turns to generate. */
  readonly turns?: number
}

/** Semantic marker helpers returned with a generated fixture. */
interface ChatScrollMarkers {
  /** Marker painted in the human message for a turn. */
  user(turn: number): string
  /** Marker painted in the final assistant message for a turn. */
  assistant(turn: number): string
  /** Marker painted in one seeded bash call and result. */
  tool(turn: number, index: number): string
}

/** Generated JSONL plus the stable facts browser scenarios assert. */
export interface ChatScrollFixture {
  readonly log: string
  readonly markers: ChatScrollMarkers
  readonly title: string
  readonly turns: number
}

const DEFAULT_TURNS = 88
const TOOL_INTERVAL = 8
const CODE_INTERVAL = 11

function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

function suffix(turn: number): string {
  return String(turn).padStart(3, '0')
}

function markerHelpers(prefix: string): ChatScrollMarkers {
  return {
    user: turn => `CHAT_SCROLL_${prefix}_USER_${suffix(turn)}`,
    assistant: turn => `CHAT_SCROLL_${prefix}_ASSISTANT_${suffix(turn)}`,
    tool: (turn, index) => `CHAT_SCROLL_${prefix}_TOOL_${suffix(turn)}_${String(index)}`,
  }
}

function appendRequestHeader(session: Session, turn: number, step: number): void {
  session.append('request/header', {
    header: {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      system: `Synthetic chat-scroll request for turn ${String(turn)}, step ${String(step)}.`,
    },
    reason: turn === 1 && step === 1 ? 'initial' : 'change',
  })
}

function appendAssistant(session: Session, turn: number, step: number, body: string): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: text(body),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: {
      inputTokens: 2_000 + turn * 7,
      outputTokens: 180 + step * 20,
    },
  }, { surfaceOp: 'append' })
}

function codeBlock(turn: number): string {
  if (turn % CODE_INTERVAL !== 0) return ''
  const lines = Array.from(
    { length: 30 },
    (_, index) => `const scroll_case_${suffix(turn)}_${String(index).padStart(2, '0')} = ${String(turn + index)}`,
  )
  return `\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\``
}

function appendToolStep(
  session: Session,
  markers: ChatScrollMarkers,
  turn: number,
): void {
  const calls = [1, 2].map((index) => {
    const marker = markers.tool(turn, index)
    const callId = ToolCallId(`chat-scroll-${suffix(turn)}-${String(index)}`)
    const args = JSON.stringify({
      command: `printf '${marker}\\n'`,
      description: marker,
    })
    return { args, callId, marker }
  })

  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: `Inspecting two scroll fixtures for turn ${String(turn)}.` },
        ...calls.map(call => ({
          type: 'tool-call' as const,
          id: call.callId,
          name: 'bash',
          arguments: call.args,
        })),
      ],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: { inputTokens: 2_000 + turn * 7, outputTokens: 240, reasoningTokens: 30 },
  }, { surfaceOp: 'append' })

  for (const call of calls) {
    const source = session.append('tool/call', {
      turn,
      step: 1,
      callId: call.callId,
      name: 'bash',
      arguments: call.args,
    })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId: call.callId,
        content: text(Array.from(
          { length: 12 },
          (_, line) => `${call.marker} output line ${String(line + 1).padStart(2, '0')}`,
        ).join('\n')),
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
}

function fixtureLog(session: Session): string {
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: Date.now() - 60_000,
      cwd: '{{cwd}}',
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

/**
 * Build a multi-page conversation with prose, fenced code, and paired bash
 * calls/results. Every turn is closed, so cold resume cannot repair or mutate
 * the seed before the browser observes it.
 * @param options - Fixture identity and optional turn count.
 * @returns Canonical JSONL and semantic marker helpers.
 */
export function createChatScrollFixture(options: ChatScrollFixtureOptions): ChatScrollFixture {
  const turns = options.turns ?? DEFAULT_TURNS
  const markers = markerHelpers(options.markerPrefix)
  const session = Session.create(SessionId(`chat-scroll-${options.markerPrefix.toLowerCase()}-template`))

  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', {
      turn,
    })
    const user = session.append('user/message', createUserMessage({
      content: text(
        `${markers.user(turn)} Review the long-running conversation state for turn ${String(turn)}. `
        + 'Keep the visible message stable while history, tools, and new output change around it.',
      ),
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) {
      session.append('session/title', {
        title: options.title,
        messageSeqs: [user.seq],
        source: { kind: 'fallback' },
      })
    }

    session.append('step/start', { turn, step: 1 })
    appendRequestHeader(session, turn, 1)
    if (turn % TOOL_INTERVAL === 0) {
      appendToolStep(session, markers, turn)
      session.append('step/end', { turn, step: 1 })
      session.append('step/start', { turn, step: 2 })
      appendRequestHeader(session, turn, 2)
      appendAssistant(
        session,
        turn,
        2,
        `${markers.assistant(turn)} Both tool results are accounted for. `
        + `This settled response keeps turn ${String(turn)} identifiable after paging.${codeBlock(turn)}`,
      )
      session.append('step/end', { turn, step: 2 })
    } else {
      appendAssistant(
        session,
        turn,
        1,
        `${markers.assistant(turn)} The conversation remains readable after several paragraphs.\n\n`
        + `Turn ${String(turn)} deliberately carries enough prose to wrap at narrower viewport widths. `
        + 'The semantic marker stays near the start so geometry probes can find the same rendered row.\n\n'
        + `The closing paragraph makes this a realistic assistant response rather than a one-line list item.${codeBlock(turn)}`,
      )
      session.append('step/end', { turn, step: 1 })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  return { log: fixtureLog(session), markers, title: options.title, turns }
}
