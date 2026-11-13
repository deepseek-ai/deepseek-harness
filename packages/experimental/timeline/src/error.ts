import { HarnessError } from '@deepseek-ai/dsh-error'
import type { output, ZodType } from 'zod'

/** A Timeline failure with a stable tool-result code. */
export class TimelineError extends HarnessError {
  constructor(
    message: string,
    code: 'TIMELINE_INVALID_ARGUMENT' | 'TIMELINE_PERSISTENCE' | 'TIMELINE_PLUGIN_CONFLICT' = 'TIMELINE_INVALID_ARGUMENT',
    options?: ErrorOptions,
  ) {
    super(message, code, options)
  }
}

/**
 * Read one tool argument and name the field when validation fails.
 * @param schema - argument validation rules.
 * @param value - argument to validate.
 * @param field - argument name shown to the model.
 * @returns the validated argument.
 */
export function parseArgument<S extends ZodType>(schema: S, value: unknown, field: string): output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const detail = parsed.error.issues.slice(0, 1).map(({ path, message }) =>
    ` ${[field, ...path].join('.')}: ${message}`,
  ).join('')
  throw new TimelineError(`Invalid Timeline argument.${detail}`, 'TIMELINE_INVALID_ARGUMENT', { cause: parsed.error })
}
