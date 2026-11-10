/** Connect retained application objects to the calling program's current logged tool binding. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCuaApi } from './api.ts'
import type { CuaApi, CuaOperation } from './types.ts'

/** Standard tools.cua binding; screenshots resolve to stored program images. */
export type CuaToolBinding = (operation: CuaOperation) => Promise<JsonValue>

/**
 * Connect the object API without owning an evaluator or its lifetime.
 * @param getTool - Resolves the current execution's tools.cua binding on every operation; do not capture a completed execution's binding.
 * @returns Application and window objects using the current tool binding. Rejections propagate without retries.
 */
export function connectCua(getTool: () => CuaToolBinding): CuaApi {
  return createCuaApi(operation => getTool()(operation))
}
