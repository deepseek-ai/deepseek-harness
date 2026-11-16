import { describe, expectTypeOf, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  ToolDispatchExecution,
  ToolExecution,
  ToolExecutionInput,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'

function inputAndExecutionContracts(
  input: ToolExecutionInput,
  execution: ToolExecution,
  run: ToolRunContext,
): void {
  // @ts-expect-error -- every typed invocation must supply a caller-owned signal.
  const missingSignal: ToolExecutionInput = { callId: brandString<ToolCallId>('missing'), name: 'probe', arguments: {} }
  void missingSignal

  // @ts-expect-error -- caller input is readonly after construction.
  input.signal = new AbortController().signal
  // @ts-expect-error -- required readonly properties cannot be deleted.
  delete input.signal
  // @ts-expect-error -- required signals cannot become undefined.
  input.signal = undefined

  // @ts-expect-error -- pipeline observers receive a readonly execution view.
  execution.signal = new AbortController().signal
  // @ts-expect-error -- pipeline observers cannot remove the required signal.
  delete execution.signal
  // @ts-expect-error -- tool bodies receive a readonly run context.
  run.signal = new AbortController().signal
  // @ts-expect-error -- tool bodies cannot remove the required signal.
  delete run.signal
  // @ts-expect-error -- tool bodies cannot replace the required signal with undefined.
  run.signal = undefined
}
void inputAndExecutionContracts

function observerContracts(ctx: Context): void {
  ctx.on('tools/pre-execute', (exec, next) => {
    // @ts-expect-error -- pre-policy sees a readonly signal.
    exec.signal = new AbortController().signal
    // @ts-expect-error -- pre-policy cannot remove the required signal.
    delete exec.signal
    // @ts-expect-error -- pre-policy cannot replace the required signal with undefined.
    exec.signal = undefined
    return next()
  })
  ctx.on('tools/post-execute', (exec, _result, next) => {
    // @ts-expect-error -- post-policy sees a readonly signal.
    exec.signal = new AbortController().signal
    // @ts-expect-error -- post-policy sees a readonly signal.
    delete exec.signal
    // @ts-expect-error -- post-policy cannot replace the required signal with undefined.
    exec.signal = undefined
    return next()
  })
  ctx.on('tools/result', (exec) => {
    // @ts-expect-error -- result observers see a readonly signal.
    exec.signal = new AbortController().signal
    // @ts-expect-error -- result observers cannot remove the required signal.
    delete exec.signal
    // @ts-expect-error -- result observers see a readonly signal.
    exec.signal = undefined
  })
  ctx.on('tools/execute', (exec, next) => {
    exec.signal = new AbortController().signal
    // @ts-expect-error -- around-dispatch may replace but not remove the signal.
    delete exec.signal
    // @ts-expect-error -- around-dispatch cannot replace the required signal with undefined.
    exec.signal = undefined
    return next()
  })
}
void observerContracts

const inferredTool = defineTool({
  name: 'signal-inference',
  description: 'Pins contextual signal inference.',
  parameters: {},
  output: {
    schema: { type: 'null' },
    render: () => [],
  },
  async execute(_args, exec) {
    expectTypeOf(exec.signal).toEqualTypeOf<AbortSignal>()
    // @ts-expect-error -- defineTool contextually exposes a readonly signal.
    exec.signal = new AbortController().signal
    return null
  },
})
void inferredTool

describe('tool execution signal types', () => {
  it('requires an exact AbortSignal at every readonly tool view', () => {
    expectTypeOf<ToolExecutionInput['signal']>().toEqualTypeOf<AbortSignal>()
    expectTypeOf<ToolExecution['signal']>().toEqualTypeOf<AbortSignal>()
    expectTypeOf<ToolRunContext['signal']>().toEqualTypeOf<AbortSignal>()
    expectTypeOf<ToolDispatchExecution['signal']>().toEqualTypeOf<AbortSignal>()
    expectTypeOf<typeof inferredTool.execute>().toBeFunction()
  })
})
