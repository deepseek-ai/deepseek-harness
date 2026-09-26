/**
 * Gate for forbidden credential or endpoint environment inlines in shipped
 * Cordis configuration.
 * @module scripts/verify-config-source-ownership
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Shipped Cordis configuration these rules apply to. */
const SHIPPED_CONFIG_GLOBS = [
  'apps/*/config/**/*.yml',
  // Bundle identity comes from the package manifest, not the domain directory.
  'packages/*/*/cordis.patch.yml',
  'packages/*/*/presets/*.patch.yml',
  // The Python runtime ships its own default composition inside the wheel.
  'python/*/src/**/cordis.yml',
]

/** Ordinary single-line configuration forms this source check rejects; not full YAML analysis. */
const INLINE_DENY = /^\s*(apiKey|baseURL|apiKeyEnv|authToken|headers)\s*:\s*!!js\b/

/** Return every forbidden inline environment form in shipped configuration. */
export function collectConfigSourceOwnershipViolations(root: string): string[] {
  const failures: string[] = []
  for (const glob of SHIPPED_CONFIG_GLOBS) {
    for (const file of globSync(glob, { cwd: root })) {
      const rel = file.split(sep).join('/')
      readFileSync(resolve(root, rel), 'utf8').split('\n').forEach((line, index) => {
        if (!INLINE_DENY.test(line)) return
        failures.push(
          `${rel}:${String(index + 1)}: inlines a credential or endpoint from the environment.`
          + ' The adapter resolves apiKeyEnv through ctx.credentials and the endpoint through the'
          + ' environment snapshot; inlining here bypasses both ladders.',
        )
      })
    }
  }
  return failures
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const failures = collectConfigSourceOwnershipViolations(ROOT)
  if (failures.length > 0) {
    process.stderr.write('verify-config-source-ownership: configuration source ownership violated:\n')
    for (const failure of failures) process.stderr.write(`  ${failure}\n`)
    process.exit(1)
  }

  process.stdout.write(
    'verify-config-source-ownership: no credential or endpoint uses the ordinary inline environment form'
    + ' in shipped configuration.\n',
  )
}
