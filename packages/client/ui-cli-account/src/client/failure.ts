import type { CliCommandFailure } from '@deepseek-ai/dsh-cli-account/types'

export function describeFailure(
  failure: CliCommandFailure | undefined, exitCode: (code: string) => string, details: readonly (string | undefined)[] = [],
): string | undefined {
  if (failure === undefined) return undefined
  return [
    failure.command,
    ...failure.exitCode === null ? [] : [exitCode(String(failure.exitCode))],
    ...details.filter(detail => detail !== undefined),
  ].join(' · ')
}
