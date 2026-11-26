/** Provider-owned identifiers for registered execution environments. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

/** Stable provider-owned registry key; display names do not identify an environment. */
export type EnvironmentHandle = Branded<'EnvironmentHandle'>

/**
 * Admit a non-empty provider identifier without interpreting its format.
 * @param value - stable identifier chosen by the provider.
 * @returns the branded registry key.
 */
export function EnvironmentHandle(value: string): EnvironmentHandle {
  return brandString<EnvironmentHandle>(z.string().min(1).parse(value))
}
