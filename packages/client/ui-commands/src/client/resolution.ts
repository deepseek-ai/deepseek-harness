/** Command identity and localized input spelling over the effective Host catalog. */
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { en, zh } from './locales.ts'

const BUILTINS = {
  goal: '@deepseek-ai/dsh-command-goal',
  plan: '@deepseek-ai/dsh-plan-mode',
  feedback: '@deepseek-ai/dsh-command-feedback',
  compact: '@deepseek-ai/dsh-command-compact',
  permission: '@deepseek-ai/dsh-permission-presets',
  export: '@deepseek-ai/dsh-session-log-export',
} as const

/** Names whose first-party definitions have localized client presentation. */
export type BuiltinCommandName = keyof typeof BUILTINS

/**
 * Identify a first-party definition without interpreting its display copy.
 * @param descriptor - effective Host descriptor after scoped shadowing.
 * @returns its first-party name, or undefined for another definition.
 */
export function builtinCommandName(descriptor: CommandDescriptor): BuiltinCommandName | undefined {
  return (Object.keys(BUILTINS) as BuiltinCommandName[])
    .find(name => descriptor.definitionId === BUILTINS[name])
}

/**
 * Select the input spelling for a menu-picked command.
 * @param descriptor - effective Host descriptor.
 * @param t - command-namespace translator.
 * @returns localized spelling for a known definition, otherwise its registered name.
 */
export function claimToken(descriptor: CommandDescriptor, t: TranslateNS<'command'>): string {
  const name = builtinCommandName(descriptor)
  return name === undefined ? descriptor.name : t(`token.${name}`)
}

const TOKEN_ALIASES = new Map(
  (Object.keys(BUILTINS) as BuiltinCommandName[]).flatMap(name =>
    [zh[`token.${name}`], en[`token.${name}`]].map(token => [token, name] as const)),
)

/**
 * Resolve typed spelling against the current Session's effective definitions.
 * @param token - typed name without its leading slash.
 * @param descriptors - effective descriptors in the Session's ready catalog.
 * @returns the matching descriptor; aliases never select an unrelated scoped override.
 */
export function resolveCommand(
  token: string,
  descriptors: readonly CommandDescriptor[],
): CommandDescriptor | undefined {
  const exact = descriptors.find(descriptor => descriptor.name === token)
  if (exact !== undefined) return exact
  const name = TOKEN_ALIASES.get(token)
  if (name === undefined) return undefined
  return descriptors.find(descriptor => descriptor.definitionId === BUILTINS[name])
}
