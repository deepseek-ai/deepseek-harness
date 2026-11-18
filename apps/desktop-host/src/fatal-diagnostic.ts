/** Bounded Host failure details sent to the Desktop crash reporter. */

import { inspect } from 'node:util'
import { StartupError } from '@deepseek-ai/dsh-app-boot'

/** Maximum characters carried by one fatal diagnostic, including its truncation notice. */
export const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

/** Original-error budget when startup metadata needs space in the same report. */
const MAX_ORIGINAL_ERROR_CHARS = 8 * 1024

/** Startup entry details leave room for composition and provider observations. */
const MAX_STARTUP_ENTRY_CHARS = 8 * 1024

/**
 * Render the original error and explicitly selected startup metadata.
 * Selected metadata excludes configuration values and arbitrary startup logger arguments.
 * @param error - Failure received by the Host entry point.
 * @returns Bounded text with an explicit notice when the report is shortened.
 */
export function formatFatalDiagnostic(error: unknown): string {
  const original = inspect(error, { depth: 4, maxArrayLength: 50 })
  const sections: string[] = []
  const seen = new Set<Error>()
  function visit(value: unknown): void {
    if (!(value instanceof Error) || seen.has(value)) return
    seen.add(value)
    if (value instanceof StartupError) {
      if (value.startup !== undefined) {
        sections.push(`Configuration file: ${value.startup.configurationPath}`)
      }
      const entries = inspect(value.entries, { depth: 6, maxArrayLength: null, maxStringLength: 4096 })
      sections.push('--- startup entries ---', entries.length <= MAX_STARTUP_ENTRY_CHARS ? entries
        : `${entries.slice(0, MAX_STARTUP_ENTRY_CHARS).replace(/[\uD800-\uDBFF]$/u, '')}\n… (startup entries truncated at ${MAX_STARTUP_ENTRY_CHARS} characters)`)
      if (value.composition !== undefined) {
        const { plugins, services, omittedPlugins, omittedServices } = value.composition
        const sources = [...new Set(plugins.map(plugin => plugin.source))]
        sections.push('--- startup composition ---',
          'Provider lists contain observed registrations only; an empty list means the provider is unknown.',
          'Source identifies the Loader tree, not necessarily the overriding patch.',
          `Omitted plugin rows: ${omittedPlugins}; omitted missing-service observations: ${omittedServices}.`,
          '--- missing services ---', ...services.map(service => JSON.stringify(service)),
          '--- plugin sources (sourceIndex) ---', ...sources.map((source, index) => JSON.stringify({ index, source })),
          '--- plugins (inactive first) ---', ...plugins.map(({ source, ...plugin }) => JSON.stringify({ ...plugin, sourceIndex: sources.indexOf(source) })))
      } else {
        sections.push('Startup composition diagnostic unavailable.')
      }
    }
    visit(value.cause)
    if (value instanceof AggregateError) value.errors.forEach(visit)
  }
  visit(error)
  sections.unshift(sections.length === 0 || original.length <= MAX_ORIGINAL_ERROR_CHARS ? original
    : `${original.slice(0, MAX_ORIGINAL_ERROR_CHARS).replace(/[\uD800-\uDBFF]$/u, '')}\n… (original error truncated at ${MAX_ORIGINAL_ERROR_CHARS} characters)`)
  const text = sections.join('\n')
  if (text.length <= MAX_FATAL_DIAGNOSTIC_CHARS) return text
  const notice = `\n… (Host diagnostic truncated at ${MAX_FATAL_DIAGNOSTIC_CHARS} characters)`
  return text.slice(0, MAX_FATAL_DIAGNOSTIC_CHARS - notice.length).replace(/[\uD800-\uDBFF]$/u, '') + notice
}
