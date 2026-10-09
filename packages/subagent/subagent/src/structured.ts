/**
 * Child-scoped structured-output tool, prompt instruction, terminal guard, and authoritative
 * result capture for in-process subagents. Each child registers its real schema on its own
 * scope, so concurrent runs do not interact and disposal leaves no global residue. The prompt
 * contribution is ordinary reconstructed request state.
 *
 * Capture commits only after the authoritative `tools/result` succeeds; PTC mode capture also
 * waits for the enclosing `run_code` result. The terminal result marker and monotonic tool
 * guard prevent later calls from reopening a completed structured run.
 * @module @deepseek-ai/dsh-subagent/structured
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError, validateJsonSchemaValue, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** The model-facing tool name a structured child must call to finish. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/**
 * The instruction registered as the child's trailing scoped prompt section:
 * the demand travels with the
 * tool, as ordinary prompt state of exactly one agent.
 */
export const STRUCTURED_OUTPUT_INSTRUCTION
  = 'When you have your final answer, you MUST report it by calling the '
    + `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only the tool call counts as your result.'

/** One structured run's live handle: read the captured value once the child settles. */
export interface StructuredAttachment {
  /**
   * Input stays closed from capture staging through its final result, including
   * an enclosing PTC execution. A failed result discards its capture and reopens input.
   * @returns whether the activation can accept another message.
   */
  acceptsInput(): boolean
  /**
   * The captured value, once the child called the tool with valid arguments
   * and the authoritative final tool result accepted that call.
   * @returns the committed value, or undefined while none was accepted.
   */
  captured(): { value: unknown } | undefined
}

/**
 * Attach the scoped capture tool, instruction, and enforcement to a child during
 * its creation window. Child disposal removes every registration.
 * @param childCtx - the child agent's scope context (`setup`'s argument).
 * @param schema - the trusted, already-asserted schema subset to enforce (see
 *   `assertObjectJsonSchema` in dsh-tools).
 * @param canComplete - whether accepted input and owned child work have finished.
 * @returns the attachment handle (read `captured()` after the child settles).
 */
export function attachStructuredRuntime(
  childCtx: Context,
  schema: ObjectJsonSchema,
  canComplete: () => boolean,
): StructuredAttachment {
  /**
   * Validated values staged by the capture tool body, awaiting THEIR OWN
   * authoritative `tools/result` notification. The execution object's identity
   * uniquely identifies a trip through the pipeline: adapter call ids may
   * repeat across steps, but another execution can never reach this Map
   * entry. This is distinct from the opaque `ToolExecutionToken` used to
   * correlate nested transports. The final notification always deletes its own
   * stage, whether the result succeeded or failed.
   */
  const staged = new Map<ToolExecution, { value: unknown }>()
  /** Successful nested capture waiting for its enclosing transport to commit. */
  let pending: { parent: ToolExecution['token']; value: unknown } | undefined
  let captured: { value: unknown } | undefined

  const schemaEntry: ToolSchema = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    parameters: { ...schema },
  }

  childCtx.tools.register({
    ...schemaEntry,
    output: {
      schema: {
        type: 'object',
        properties: { recorded: { type: 'boolean', const: true } },
        required: ['recorded'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: 'Structured output recorded.' }],
    },
    execute(args: unknown, exec: ToolRunContext): Promise<{ recorded: true }> {
      const violations = validateJsonSchemaValue(schema, args)
      // ToolArgsError → isError result with INVALID_ARGS: the model retries
      // within the same turn, exactly like a schema-validated defineTool call.
      if (violations.length > 0) throw new ToolArgsError(violations)
      if (!canComplete()) throw new Error('Wait for all delegated child tasks to finish and process pending messages before submitting structured output.')
      // Two-phase commit, keyed by THIS execution: later transformable
      // waterfalls may still turn the success into an error. ToolRuntime has
      // already frozen model-bound arguments at the actual input boundary.
      staged.set(exec, { value: args })
      exec.concludeTurn()
      return Promise.resolve({ recorded: true })
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: childCtx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  })

  // Terminal WITHIN the step. Guards run after the whole pre-execute
  // waterfall and compose monotonically (deny or abstain, never allow), so a
  // later prepended listener cannot resurrect dispatch. Calls that precede
  // capture in the same response remain untouched.
  childCtx.tools.guard(exec => captured === undefined && pending === undefined
    ? undefined
    : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`)

  // The capture COMMIT observes the immutable, authoritative result after the
  // complete pipeline and outer error normalization. This notification cannot
  // transform the outcome, so there is no wrapper outside the commit verdict.
  childCtx.on('tools/result', function (this: unknown, exec, result) {
    if (exec.name === STRUCTURED_OUTPUT_TOOL) {
      const entry = staged.get(exec)
      if (entry === undefined) return
      staged.delete(exec)
      if (result.isError) return
      if (exec.parent === undefined) {
        /* v8 ignore else -- sequential agent-loop dispatch lets the guard block every later supported call */
        if (captured === undefined) captured = { value: entry.value }
      } else {
        /* v8 ignore else -- PTC mode serializes sub-dispatches, so the guard blocks every later supported call */
        if (captured === undefined && pending === undefined) {
          pending = { parent: exec.parent, value: entry.value }
        }
      }
      return
    }
    if (pending?.parent !== exec.token) return
    const entry = pending
    pending = undefined
    if (result.isError) return
    /* v8 ignore else -- PTC mode serializes outer executions, so the guard blocks every later supported call */
    if (captured === undefined) captured = { value: entry.value }
  })

  return {
    captured: () => captured,
    acceptsInput: () => staged.size === 0 && pending === undefined && captured === undefined,
  }
}
