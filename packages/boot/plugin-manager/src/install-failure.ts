/**
 * What a failed pnpm run was, read off how it ended and what it printed:
 * pnpm names its failures with stable `ERR_PNPM_*` codes and Node's errno
 * names, which the run's captured tail carries whatever the locale.
 * @module @deepseek-ai/dsh-plugin-manager/install-failure
 */

import type { PluginInstallFailureKind } from './types.ts'

/** How a run ended, beyond its exit code. */
export interface InstallFailureFacts {
  /** The output tail the failure reports. */
  readonly log: string
  /** The spawn error, when the child never ran. */
  readonly cause?: unknown
  /** Whether the run outlived its bound. */
  readonly timedOut?: boolean
}

/** Patterns in the order they decide: a specific code before the generic network family. */
const LOG_KINDS: readonly [PluginInstallFailureKind, RegExp][] = [
  ['build-blocked', /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/],
  ['not-found', /ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - GET/],
  ['no-matching-version', /ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version/],
  ['disk-full', /\bENOSPC\b|no space left on device/i],
  ['permission', /\bEACCES\b|\bEPERM\b|permission denied/i],
  ['integrity', /ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE|\bEINTEGRITY\b/],
  ['network', /\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_TIMEOUT|socket hang up|Could not resolve host|unable to access/],
]

/**
 * Classify a failed run.
 * @param facts - how the run ended and what it printed.
 * @returns the kind, `unknown` when nothing in the facts names one.
 */
export function classifyInstallFailure(facts: InstallFailureFacts): PluginInstallFailureKind {
  if (facts.timedOut === true) return 'timeout'
  if ((facts.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'pnpm-missing'
  for (const [kind, pattern] of LOG_KINDS) {
    if (pattern.test(facts.log)) return kind
  }
  return 'unknown'
}
