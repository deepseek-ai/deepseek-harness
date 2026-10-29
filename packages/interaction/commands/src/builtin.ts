/** First-party command identities and input spellings shared by Host and Client adapters. */
import type { CommandDescriptor } from './types.ts'

const BUILTINS = {
  goal: '@deepseek-ai/dsh-command-goal',
  plan: '@deepseek-ai/dsh-plan-mode',
  feedback: '@deepseek-ai/dsh-command-feedback',
  compact: '@deepseek-ai/dsh-command-compact',
  permission: '@deepseek-ai/dsh-permission-presets',
  export: '@deepseek-ai/dsh-session-log-export',
} as const

/** Stable first-party capabilities, independent of their registered command names. */
export type BuiltinCommandName = keyof typeof BUILTINS

/** English and Simplified Chinese spellings recognized by command input. */
export const builtinCommandTokens = {
  en: { goal: 'goal', plan: 'plan', feedback: 'feedback', compact: 'compact', permission: 'permission', export: 'export' },
  zh: { goal: '目标', plan: '计划', feedback: '反馈', compact: '压缩', permission: '权限', export: '导出' },
} as const satisfies Record<'en' | 'zh', Record<BuiltinCommandName, string>>

/**
 * Identify a first-party definition after scoped shadowing.
 * @param descriptor - effective descriptor from the receiving Agent's catalog.
 * @returns its capability name, or undefined for another definition.
 */
export function builtinCommandName(descriptor: CommandDescriptor): BuiltinCommandName | undefined {
  return (Object.keys(BUILTINS) as BuiltinCommandName[])
    .find(name => descriptor.definitionId === BUILTINS[name])
}

const TOKEN_ALIASES = new Map<string, BuiltinCommandName>(
  (Object.keys(BUILTINS) as BuiltinCommandName[]).flatMap(name =>
    [builtinCommandTokens.zh[name], builtinCommandTokens.en[name]].map(token => [token, name] as const)),
)

/**
 * Resolve typed spelling without overriding an exact scoped command name.
 * @param token - typed name without its leading slash.
 * @param descriptors - effective descriptors in the receiving Agent's catalog.
 * @returns the matching descriptor; aliases only select their first-party definition.
 */
export function resolveCommand(token: string, descriptors: readonly CommandDescriptor[]): CommandDescriptor | undefined {
  const exact = descriptors.find(descriptor => descriptor.name === token)
  if (exact !== undefined) return exact
  const name = TOKEN_ALIASES.get(token)
  if (name === undefined) return undefined
  return descriptors.find(descriptor => descriptor.definitionId === BUILTINS[name])
}
