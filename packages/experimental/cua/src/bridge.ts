/** Connect retained application objects to the calling program's current logged tool binding. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCuaApi } from './api.ts'
import type { CuaApi, CuaOperation } from './types.ts'

/** Standard tools.cua binding; its image content is admitted by the host tool pipeline. */
export type CuaToolBinding = (operation: CuaOperation) => Promise<JsonValue>

/**
 * Connect the object API without owning an evaluator or its lifetime.
 * @param getTool - Resolves the current execution's tools.cua binding on every operation; do not capture a completed execution's binding.
 * @param onText - Optional text output captured by the caller's execution environment.
 * @returns App objects retaining tool approval, logging, image delivery and screenshot metadata. Rejections propagate without retries.
 */
export function connectCua(getTool: () => CuaToolBinding, onText?: (text: string) => void | Promise<void>): CuaApi {
  return createCuaApi(operation => getTool()(operation), {
    text: value => onText?.(value),
    // The standard tools.cua result already carries the screenshot attachment.
    image: () => {},
  })
}
