/**
 * Schema-dump entry: inspect the composed profile without applying its plugins.
 * Imports and lazy schema builders execute trusted module code.
 * @module @deepseek-ai/dsh/dump-config-schema
 */

/* v8 ignore file -- built-bin acceptance drives schema collection and output. */

import { generateConfigSchema, type ConfigSchemaDump } from '@deepseek-ai/dsh-app-boot'
import { collectConfigDumpLayers } from './dump-config.ts'
import { INSTALL_ANCHOR, prepareProfile } from './profile-boot.ts'

const NAME = 'dsh'

/**
 * Print one JSON Schema document; incomplete collection or projection sets exitCode to 1.
 * Profile initialization writes match the YAML dump. Plugin imports may execute
 * top-level code, but collection never applies plugins or evaluates `!!js`.
 * During schema generation, ordinary stdout writes are redirected to stderr.
 * @param profile - the profile name.
 * @param patches - overlay paths, in argv order.
 * @param fromDefaultProfile - shipped template used once to initialize a missing profile.
 * @returns after collection and output, with diagnostics also written to stderr.
 */
export async function runDumpConfigSchema(
  profile: string,
  patches: readonly string[],
  fromDefaultProfile?: string,
): Promise<void> {
  const loaded = prepareProfile(profile, true, fromDefaultProfile)
  const layers = collectConfigDumpLayers(loaded, false, patches)
  // oxlint-disable-next-line typescript/unbound-method -- Saved only for exact restoration, never called unbound.
  const stdoutWrite = process.stdout.write
  let dump: ConfigSchemaDump
  // Trusted module diagnostics must not precede the JSON document on stdout.
  process.stdout.write = process.stderr.write.bind(process.stderr)
  try {
    dump = await generateConfigSchema(loaded, layers.map(layer => layer.patches), INSTALL_ANCHOR)
  } finally {
    process.stdout.write = stdoutWrite
  }
  process.stdout.write(`${JSON.stringify(dump, null, 2)}\n`)
  for (const diagnostic of dump['x-cordis'].diagnostics) {
    const location = diagnostic.path === undefined ? '' : ` [${diagnostic.path}]`
    process.stderr.write(`${NAME}: ${diagnostic.level}:${location} ${diagnostic.message}\n`)
  }
  if (!dump['x-cordis'].complete) process.exitCode = 1
}
