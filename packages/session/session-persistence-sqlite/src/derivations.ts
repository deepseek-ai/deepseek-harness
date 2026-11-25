/**
 * The derived tables every store maintains, read out of the events this
 * repository declares: model calls with their token usage, tool calls, tool
 * results, and compactions. Each derivation reads only members the event
 * already carries and validates them itself, because stored `data` is
 * untrusted; an event without them yields no row. @module
 */
import { z } from 'zod'
import type { Derivation, DerivedValue } from './derive.ts'
import type { SqlFiles } from './sql.ts'

const usage = z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(),
  cacheReadTokens: z.number().int().optional(), cacheWriteTokens: z.number().int().optional(),
  reasoningTokens: z.number().int().optional() })
const assistantMessage = z.object({ turn: z.number().int(), step: z.number().int(), usage,
  message: z.object({ source: z.object({ provider: z.string(), model: z.string() }) }) })
const summary = z.object({ provider: z.string(), model: z.string(), usage })
const toolCall = z.object({ turn: z.number().int(), step: z.number().int(), name: z.string() })
const toolResult = z.object({ message: z.object({ isError: z.boolean().optional() }), error: z.object({ code: z.string() }).optional() })
const shadowedRange = z.object({ start: z.number().int(), end: z.number().int() })
const shadowed = z.object({ shadowedTokenCount: z.number().int(), shadowedRange })

function tokens(value: z.infer<typeof usage>): DerivedValue[] {
  return [value.inputTokens, value.outputTokens, value.cacheReadTokens ?? null, value.cacheWriteTokens ?? null,
    value.reasoningTokens ?? null]
}

/**
 * The built-in derivations, in the order their views depend on each other.
 * @param sql - SQL files holding the built-in view bodies; none is read until a view body is first used.
 * @returns the derivations every store maintains.
 */
export function builtinDerivations(sql: SqlFiles): readonly Derivation[] {
  return [{
    name: 'llm_calls', version: 1, types: ['assistant/message', 'compaction/summary'],
    columns: { time: 'INTEGER NOT NULL', provider: 'TEXT NOT NULL', model: 'TEXT NOT NULL', turn: 'INTEGER', step: 'INTEGER',
      input_tokens: 'INTEGER NOT NULL', output_tokens: 'INTEGER NOT NULL', cache_read_tokens: 'INTEGER',
      cache_write_tokens: 'INTEGER', reasoning_tokens: 'INTEGER' },
    derive(event) {
      if (event.type === 'compaction/summary') {
        const call = summary.safeParse(event.data)
        return call.success ? [event.time, call.data.provider, call.data.model, null, null, ...tokens(call.data.usage)] : undefined
      }
      const call = assistantMessage.safeParse(event.data)
      if (!call.success) return undefined
      const { provider, model } = call.data.message.source
      return [event.time, provider, model, call.data.turn, call.data.step, ...tokens(call.data.usage)]
    },
  }, {
    name: 'tool_calls', version: 1, types: ['tool/call'],
    columns: { time: 'INTEGER NOT NULL', tool: 'TEXT NOT NULL', turn: 'INTEGER NOT NULL', step: 'INTEGER NOT NULL' },
    derive(event) {
      const call = toolCall.safeParse(event.data)
      return call.success ? [event.time, call.data.name, call.data.turn, call.data.step] : undefined
    },
  }, {
    name: 'tool_results', version: 1, types: ['tool/result'],
    columns: { time: 'INTEGER NOT NULL', call_seq: 'INTEGER', is_error: 'INTEGER NOT NULL', error_code: 'TEXT' },
    indexes: [['segment_id', 'call_seq']],
    // Read when the view is created, so building this list reads no file.
    views: { get session_tools() { return sql.text('derived/session-tools') } },
    derive(event) {
      const result = toolResult.safeParse(event.data)
      if (!result.success) return undefined
      // A result appended to the conversation cites its call; one that replaces an earlier result cites that result.
      const call = event.surfaceOp === 'append' ? event.sourceEventSeqs?.[0] : undefined
      return [event.time, call ?? null, result.data.message.isError === true ? 1 : 0, result.data.error?.code ?? null]
    },
  }, {
    name: 'compactions', version: 1, types: ['compaction/prune', 'compaction/summary'],
    columns: { time: 'INTEGER NOT NULL', kind: 'TEXT NOT NULL', shadowed_tokens: 'INTEGER NOT NULL',
      shadowed_start: 'INTEGER NOT NULL', shadowed_end: 'INTEGER NOT NULL' },
    derive(event) {
      const range = shadowed.safeParse(event.data)
      return range.success
        ? [event.time, event.type === 'compaction/prune' ? 'prune' : 'summary', range.data.shadowedTokenCount,
          range.data.shadowedRange.start, range.data.shadowedRange.end]
        : undefined
    },
  }]
}
