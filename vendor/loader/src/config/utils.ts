import { valueMap } from '@deepseek-ai/cosmokit'

// eslint-disable-next-line no-new-func
/** Evaluate a JavaScript expression against a loader context scope. */
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`) as ((ctx: object, expr: string) => any)

/** Recursively replace YAML `!!js` expression nodes with evaluated values. */
export function interpolate(ctx: object, value: any) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(ctx, item))
  } else {
    return valueMap(value, item => interpolate(ctx, item))
  }
}

/** Return true when a value is a serialized loader JavaScript expression. */
export function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && typeof value.__jsExpr === 'string'
}

/** Serialized JavaScript expression produced by the include YAML tag. */
export interface JsExpr {
  __jsExpr: string
}

/** Source position of a config value: 1-based, with columns in UTF-16 code units. */
export interface SourceLocation {
  /** Path of the config file that writes the value. */
  filename: string
  line: number
  column: number
}

/**
 * Format a source position as `file:line:column`.
 * @param location - Position to format.
 * @returns The formatted position.
 */
export function formatLocation(location: SourceLocation) {
  return `${location.filename}:${location.line}:${location.column}`
}

/**
 * Format one validation issue as an indented list item.
 * @param message - Issue description.
 * @param location - Source position of the value, when known.
 * @param path - Dotted option path of the value, when not the root.
 * @returns The list item, with its path and position in parentheses.
 */
export function formatIssue(message: string, location?: SourceLocation, path?: string) {
  const where = [path, location && formatLocation(location)].filter(Boolean).join(', ')
  return where ? `  - ${message} (at ${where})` : `  - ${message}`
}

/** One rejected entry option. */
export interface Issue {
  message: string
  /** Path from the entry options to the rejected value; empty for the entry itself. */
  path: PropertyKey[]
}

/** Map an option path to the source position that writes it. */
export type Locate = (path: PropertyKey[]) => SourceLocation | undefined

/**
 * Format a titled list of validation issues.
 * @param title - First line of the message.
 * @param issues - Issues to list in order.
 * @param locate - Resolves each issue path to a source position.
 * @returns The multi-line message.
 */
export function formatIssues(title: string, issues: readonly Issue[], locate?: Locate) {
  const lines = issues.map(({ message, path }) => {
    return formatIssue(message, locate?.(path), path.length ? path.map(String).join('.') : undefined)
  })
  return `${title}:\n${lines.join('\n')}`
}

/**
 * Replace an error's message and stack frames, so the error points at the config source instead of the loader internals.
 * @param error - Error to rewrite in place.
 * @param message - New message.
 * @param frames - Stack frames listed after the message line.
 */
export function relocate(error: Error, message: string, frames: string[]) {
  error.message = message
  error.stack = [`${error.name}: ${message}`, ...frames].join('\n')
}

/** Entry options rejected by `validateOptions()`; `issues` lists every rejected option. */
export class EntryValidationError extends TypeError {
  name = 'EntryValidationError'

  constructor(public issues: Issue[]) {
    super(formatIssues('invalid entry options', issues))
  }
}

// only `disabled` takes an expression
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !isJsExpr(value)
}

/**
 * Check entry options before an entry is created or updated. Explicit ids may contain `sep`.
 * @param options - Candidate entry options.
 * @param sep - Tree id separator; kept for the upstream signature.
 * @param deep - Also check the entries of a group's `config`.
 * @returns Every issue found; empty when the options are valid.
 */
export function validateOptions(options: unknown, sep: string, deep = false): Issue[] {
  if (!isPlainObject(options)) return [{ message: 'entry must be an object', path: [] }]
  const issues: Issue[] = []
  const check = (key: string, expected: string, valid: (value: any) => boolean, required = false) => {
    const value = options[key]
    if (value === undefined || value === null) {
      if (required) issues.push({ message: `${key} is required`, path: [key] })
    } else if (!valid(value)) {
      issues.push({ message: `${key} must be ${expected}`, path: [key] })
    }
  }

  check('id', 'a string', value => typeof value === 'string')
  check('name', 'a string', value => typeof value === 'string', true)
  check('group', 'a boolean', value => typeof value === 'boolean')
  check('disabled', 'a boolean', value => typeof value === 'boolean' || isJsExpr(value))
  // a group's config is its entry list
  if (options.group === true) check('config', 'an array', Array.isArray, true)

  check('inject', 'an array or an object', value => Array.isArray(value) || isPlainObject(value))
  if (Array.isArray(options.inject)) {
    options.inject.forEach((name, index) => {
      if (typeof name === 'string') return
      issues.push({ message: `inject.${index} must be a string`, path: ['inject', index] })
    })
  }
  check('intercept', 'an object', isPlainObject)
  check('isolate', 'an object', isPlainObject)
  if (isPlainObject(options.isolate)) {
    for (const [name, label] of Object.entries(options.isolate)) {
      if (label === true || typeof label === 'string') continue
      issues.push({ message: `isolate.${name} must be true or a string`, path: ['isolate', name] })
    }
  }
  // from a source, each entry is checked as its group creates it
  if (deep && options.group === true && Array.isArray(options.config)) {
    options.config.forEach((child, index) => {
      for (const { message, path } of validateOptions(child, sep, true)) {
        issues.push({ message, path: ['config', index, ...path] })
      }
    })
  }
  return issues
}
