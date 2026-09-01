import { IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { planSummary, type PlanItemLike } from './plan-summary.ts'

type TodoRowProps = ToolCallViewProps & PropsLocale<'conversation'>

function isItem(value: unknown): value is PlanItemLike {
  return typeof value === 'object' && value !== null
}

/**
 * The row's summary split at the ellipsis boundary: `text` truncates, `extra`
 * is the parallel-active count that must not, so a narrow row never clips the
 * one part that says several tasks are running.
 */
interface RowSummary {
  text: string
  extra: number
}

function summarize(argsRaw: string, t: TodoRowProps['t']): RowSummary | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    // Mid-stream truncation or malformed model JSON: fall back to the generic summary.
    return null
  }
  // Valid JSON with invalid todo fields (null root, non-array todos, null items —
  // a rejected tool/call retains such args verbatim): same generic fallback.
  if (typeof parsed !== 'object' || parsed === null) return null
  const todos = (parsed as { todos?: unknown }).todos
  if (!Array.isArray(todos) || !todos.every(isItem)) return null
  const { done, total, activeContent, activeExtra } = planSummary(todos)
  const head = t('todo.completed', { done, total })
  return {
    text: activeContent === null ? head : `${head} · ${activeContent}`,
    extra: activeExtra,
  }
}

/** Summarizes a plan update without presenting a cancelled call as completed. */
export function TodoRow({ toolName, block, inspect, t }: TodoRowProps) {
  const model = toolRowModel(toolName, block)
  const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  const summary = summarize(argsRaw, t) ?? { text: model.summary, extra: 0 }
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconChecklistOutline14 />}
      title={t('todo.rowTitle')}
      summary={summary.text}
      summarySuffix={summary.extra > 0 ? `+${summary.extra}` : null}
      bodyRaw={model.bodyRaw}
      output={model.output}
      errorSummary={model.errorSummary}
      state={model.state}
      inspect={inspect}
    />
  )
}

/** Registers the todo conversation row. */
export const todoToolview = {
  name: 'todo-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'todo_write', locale: NS }, TodoRow))
  },
}
