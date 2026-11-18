/** Model placeholder for consumer tests that do not read or change model selection. */
import type { Model } from '@deepseek-ai/dsh-agent'

/**
 * Create an unsupported Model placeholder for structural Agent stubs.
 * @returns a Model whose operations throw at the first unexpected dependency.
 */
export function unsupportedModel(): Model {
  const reject = (): never => {
    throw new Error('this test Agent does not support model selection')
  }
  return { current: reject, select: reject }
}
