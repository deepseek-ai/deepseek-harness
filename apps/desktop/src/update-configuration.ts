/** Safe user-facing classifications for shell update settings failures. */
import type { DesktopChannelChangeResult, DesktopChannelState } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import { DesktopSettingsFileError } from './settings-file.ts'
import type { DesktopMessages } from './locale.ts'

/**
 * Classify an unreadable startup selection without exposing file contents.
 * @param error - Validated storage failure.
 * @returns The persistent reason updates are suspended.
 */
export function configurationFailure(error: DesktopSettingsFileError): NonNullable<DesktopChannelState['error']> {
  const problem = error.problem
  if (problem.kind !== 'invalid') return 'read'
  return problem.reason === 'field' && problem.field === 'channel' ? 'channel' : 'format'
}

/**
 * Reduce an operation failure to a short, trustworthy toast reason.
 * @param error - Failed save or channel transition.
 * @returns Safe detail for the initiating settings view.
 */
export function channelSaveFailure(error: unknown): Extract<DesktopChannelChangeResult, { kind: 'failed' }>['reason'] {
  if (!(error instanceof DesktopSettingsFileError)) return 'apply'
  if (error.problem.kind === 'write' && error.problem.effect === 'unknown') return 'uncertain'
  if (error.problem.kind === 'invalid') return 'format'
  const cause = error.cause
  if (cause instanceof Error && 'code' in cause && (cause.code === 'EACCES' || cause.code === 'EPERM')) return 'permission'
  return 'save'
}

/**
 * Explain an actual suspension and its recovery action.
 * @param reason - Persistent updater configuration failure.
 * @param messages - Current desktop locale.
 * @returns Localized dialog message.
 */
export function configurationMessage(reason: NonNullable<DesktopChannelState['error']>, messages: DesktopMessages): string {
  const key = {
    read: 'updateConfigurationRead',
    format: 'updateConfigurationFormat',
    channel: 'updateConfigurationChannel',
    cleanup: 'updateConfigurationCleanup',
  } as const
  return messages[key[reason]]
}
