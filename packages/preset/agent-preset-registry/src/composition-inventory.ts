/** Plugin inventory from declared configuration or an activated revision. */
import type { FiberState } from '@deepseek-ai/cordis'
import { isJsExpr, type EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { entryListProblem } from './definition.ts'

/**
 * Effective enablement of one composition row: a literal or evaluated
 * boolean, or `'conditional'` when a `!!js` disabled expression could not be
 * evaluated outside a mount.
 */
export type CompositionRowEnablement = boolean | 'conditional'

/**
 * Evaluate one `!!js` disabled expression the way the Loader would at a mount
 * decision. Throwing refuses the answer: the row is reported `'conditional'`
 * rather than guessed.
 */
export type DisabledExpressionEvaluator = (expression: string) => unknown

/** One plugin row a preset composition names. */
export interface AgentPresetCompositionRow {
  /**
   * Entry id relative to the preset's Loader tree, or the declared id before
   * activation; null when an unmounted row declares none.
   */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  /** Effective enablement, including disabled ancestor groups. */
  readonly enabled: CompositionRowEnablement
  /** The row's own `!!js` disabled expression, when it carries one. */
  readonly condition?: string
  /** Root-fiber state, present only when read from a live mount. */
  readonly fiberState?: FiberState
}

/** One preset's roster identity beside its composition rows. */
export interface AgentPresetComposition {
  /** Stable preset id. */
  readonly id: string
  /** Display name the preset published. */
  readonly name?: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Why this preset's rows cannot be read; absent when {@link rows} answers. */
  readonly broken?: string
  /** Composition rows in composition order; empty when the preset is broken. */
  readonly rows: readonly AgentPresetCompositionRow[]
}

/**
 * One `disabled` node's contribution to effective enablement, mirroring the
 * Loader's own reading: a `!!js` expression is asked of the evaluator — a
 * refusal (throw) leaves the decision to a mount — and anything else disables
 * exactly when `Boolean(value)` does.
 * @param value - the raw `disabled` node of one composition row.
 * @param evaluateExpression - the Loader-context evaluator for `!!js` nodes.
 * @returns true (disabled), false (enabled), or `'conditional'`.
 */
function disabledContribution(
  value: unknown,
  evaluateExpression: DisabledExpressionEvaluator,
): boolean | 'conditional' {
  if (isJsExpr(value)) {
    try {
      return Boolean(evaluateExpression(value.__jsExpr))
    } catch {
      // The evaluator refused (a malformed or context-dependent expression);
      // only a real mount decision can answer, so the row stays conditional.
      return 'conditional'
    }
  }
  return Boolean(value)
}

/**
 * Combine an ancestor group's disabled state with a row's own, the way the
 * Loader walks owning groups: any literal true disables, otherwise any
 * expression leaves the decision to a mount.
 * @param outer - the combined ancestor contribution.
 * @param own - this row's contribution.
 * @returns the row's effective disabled state.
 */
function combineDisabled(
  outer: boolean | 'conditional',
  own: boolean | 'conditional',
): boolean | 'conditional' {
  if (outer === true || own === true) return true
  if (outer === 'conditional' || own === 'conditional') return 'conditional'
  return false
}

/** A parsed composition row after {@link entryListProblem} accepted the list. */
interface RawRow {
  readonly id?: unknown
  readonly name: string
  readonly group?: unknown
  readonly config?: unknown
  readonly disabled?: unknown
}

/**
 * Flatten one parsed row list into plugin rows. Group rows are structural —
 * the Loader reports a group entry as always enabled and lets children
 * inherit its `disabled` — so only their children are emitted.
 * @param rows - the parsed rows, shape-checked by the caller.
 * @param outerDisabled - the combined ancestor-group disabled state.
 * @param evaluateExpression - the Loader-context evaluator for `!!js` nodes.
 * @param found - the accumulator receiving flattened rows.
 */
function flattenRows(
  rows: readonly unknown[],
  outerDisabled: boolean | 'conditional',
  evaluateExpression: DisabledExpressionEvaluator,
  found: AgentPresetCompositionRow[],
): void {
  for (const value of rows) {
    const row = value as RawRow
    const disabled = combineDisabled(outerDisabled, disabledContribution(row.disabled, evaluateExpression))
    if (row.group === true) {
      flattenRows(row.config as readonly unknown[], disabled, evaluateExpression, found)
      continue
    }
    found.push({
      entryId: typeof row.id === 'string' && row.id !== '' ? row.id : null,
      moduleName: row.name,
      enabled: disabled === true ? false : disabled === 'conditional' ? 'conditional' : true,
      ...isJsExpr(row.disabled) ? { condition: row.disabled.__jsExpr } : {},
    })
  }
}

/** Flatten declared child plugins for diagnostics before a successful activation.
 * @param rows Parsed child entries.
 * @param evaluateExpression Loader-context evaluator for disabled expressions.
 * @returns Flattened entries or a configuration diagnostic.
 */
export function definitionComposition(
  rows: unknown,
  evaluateExpression: DisabledExpressionEvaluator,
): { rows: AgentPresetCompositionRow[] } | { broken: string } {
  const problem = entryListProblem(rows)
  if (problem !== undefined) return { broken: problem }
  const found: AgentPresetCompositionRow[] = []
  flattenRows(rows as readonly unknown[], false, evaluateExpression, found)
  return { rows: found }
}

/**
 * Plugin rows of one live standing composition, in Loader-entry order.
 * @param tree - the standing mount's entry tree.
 * @returns rows with the Loader's evaluated enablement and root-fiber states.
 */
export function mountedCompositionRows(tree: EntryTree): AgentPresetCompositionRow[] {
  const found: AgentPresetCompositionRow[] = []
  const owner = tree.ctx.fiber.entry
  const prefix = owner === undefined ? '' : `${owner.id}:`
  for (const entry of tree.entries()) {
    if (entry.options.group) continue
    found.push({
      entryId: entry.id.slice(prefix.length),
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      ...isJsExpr(entry.options.disabled) ? { condition: entry.options.disabled.__jsExpr } : {},
      ...entry.fiber === undefined ? {} : { fiberState: entry.fiber.state },
    })
  }
  return found
}
